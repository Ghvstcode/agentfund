/**
 * Federation (protocol.md §14) between real instances on an in-process network:
 * `home` (http://af.test) and `host` (http://host.test), each with its own database.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncAll } from "../src/services/federation.js";
import { generateKeyPair, sign, verify } from "../src/lib/minisign.js";
import type { Schemas } from "../src/lib/openapi.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { raw, testNetwork, type TestNetwork } from "./helpers/network.js";
import { claim, genericCi, reportCompleted, setupProject } from "./helpers/scenario.js";

const HOME = "http://af.test";
const HOST = "http://host.test";

type Signed = Schemas["SignedDocument"];
type Peer = Schemas["Peer"];

/** `a` peers with `b` the way an admin would: look it up, confirm the key, add. */
async function peerWith(a: TestApp, admin: string, bUrl: string, opts: { accept_identities?: boolean; discover?: boolean } = {}): Promise<Peer> {
  const preview = await raw<Schemas["PeerPreview"]>(a, "POST", "/v1/admin/federation/peers/preview", { token: admin, body: { base_url: bUrl } });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const res = await raw<Peer>(a, "POST", "/v1/admin/federation/peers", { token: admin, body: { base_url: bUrl, pubkey: preview.body.pubkey, ...opts } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function vouch(home: TestApp, token: string, audience: string): Promise<Signed> {
  const res = await raw<{ assertion: Signed }>(home, "POST", "/v1/federation/assertions", { token, body: { audience } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.assertion;
}

const redeem = (at: TestApp, assertion: Signed) => raw<{ key: string; user: Schemas["Me"] }>(at, "POST", "/v1/auth/federated", { body: { assertion } });

describe("two instances", () => {
  let net: TestNetwork;
  let home: TestApp;
  let host: TestApp;
  let homeAdmin: string;
  let hostAdmin: string;

  beforeAll(async () => {
    net = testNetwork();
    home = await createTestApp({ fetch: net.fetch });
    host = await createTestApp({ fetch: net.fetch, env: { BASE_URL: HOST } });
    net.add("af.test", home);
    net.add("host.test", host);
    homeAdmin = await home.login("home-admin");
    hostAdmin = await host.login("host-admin");
  });
  afterAll(async () => {
    await host.close();
    await home.close();
  });

  it("both advertise the capability and a key", async () => {
    const meta = (await home.call<Schemas["Meta"]>("getMeta")).body;
    expect(meta.capabilities.federation).toBe(true);
    expect(meta.instance_pubkey).toBeTruthy();
  });

  it("discovery: a peer's projects are listed, attributed, and kept out of local numbers", async () => {
    await setupProject(host, "tiles", [{ id: "0001-a" }, { id: "0002-b" }]);
    const added = await peerWith(home, homeAdmin, HOST);
    expect(added).toMatchObject({ base_url: HOST, host: "host.test", status: "active", projects: 1, accepts_us: false });
    expect(added.last_synced_at).not.toBeNull();

    const page = (await home.call<{ items: Schemas["FederatedProject"][] }>("listFederatedProjects")).body.items;
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({
      id: `${HOST}/tiles`,
      url: `${HOST}/tiles`,
      slug: "tiles",
      instance: { base_url: HOST, host: "host.test" },
      tasks: { open: 2 },
      trust_tier: "new",
      accepts_local_identities: false,
    });
    expect((await home.call<{ items: unknown[] }>("listFederatedProjects", { query: { q: "nothing-like-it" } })).body.items).toHaveLength(0);
    expect((await home.call<{ items: unknown[] }>("listFederatedProjects", { query: { q: "TILE", peer: "host.test", language: "Python" } })).body.items).toHaveLength(1);
    // Local reads are untouched: the home instance still has no project of its own.
    expect((await home.call<{ items: unknown[] }>("listProjects")).body.items).toHaveLength(0);
    expect((await home.call<Schemas["Stats"]>("getStats")).body.projects).toBe(0);
  });

  it("identity is refused until the host's admin opts in, per peer", async () => {
    const alice = await home.login("alice");
    const first = await redeem(host, await vouch(home, alice, HOST));
    expect(first).toMatchObject({ status: 403, code: "peer-not-trusted" });

    // Peering for discovery alone does not admit anyone.
    await peerWith(host, hostAdmin, HOME);
    expect(await redeem(host, await vouch(home, alice, HOST))).toMatchObject({ status: 403, code: "peer-not-trusted" });

    const on = await raw<Peer>(host, "PATCH", "/v1/admin/federation/peers/af.test", { token: hostAdmin, body: { accept_identities: true } });
    expect(on.body.accept_identities).toBe(true);
    // The home instance learns it on its next sync and can tell its donors.
    await syncAll(home.ctx);
    expect((await home.call<{ items: Schemas["FederatedProject"][] }>("listFederatedProjects")).body.items[0]!.accepts_local_identities).toBe(true);
  });

  it("a home donor works on the host under their home identity, and home shows it without counting it", async () => {
    const alice = await home.login("alice");
    const assertion = await vouch(home, alice, HOST);

    // The statement is ordinary minisign: anyone holding the home instance's key can check it.
    const homeKey = (await home.call<Schemas["Meta"]>("getMeta")).body.instance_pubkey!;
    expect(() => verify(Buffer.from(assertion.payload, "utf8"), assertion.signature, homeKey)).not.toThrow();
    expect(JSON.parse(assertion.payload)).toMatchObject({ type: "agentfund-identity-v1", iss: HOME, sub: `${HOME}/u/alice`, handle: "alice", aud: HOST });

    const admitted = await redeem(host, assertion);
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(201);
    expect(admitted.body.user).toMatchObject({ id: `${HOME}/u/alice`, handle: "alice@af.test", role: "donor" });
    const key = admitted.body.key;

    // From here on it is the unchanged worker protocol.
    const c = await claim(host, key, "tiles:0001-a");
    const report = await reportCompleted(host, key, c);
    const repoUrl = (await host.call<Schemas["Project"]>("getProject", { path: { slug: "tiles" } })).body.repo_url;
    expect((await genericCi(host, repoUrl, report, { conclusion: "success" })).body.matched).toBe(true);

    const ledger = (await host.call<Schemas["Ledger"]>("getLedger", { path: { slug: "tiles" } })).body;
    expect(ledger.totals.delivered).toBe(100_000);
    expect(ledger.donors[0]).toMatchObject({ id: `${HOME}/u/alice`, handle: "alice@af.test", delivered: 100_000, tasks_delivered: 1 });
    expect((await host.call<Schemas["Donor"]>("getDonor", { path: { handle: "alice@af.test" } })).body).toMatchObject({ id: `${HOME}/u/alice`, delivered: 100_000, rank: 1 });
    const task = (await host.call<Schemas["Task"]>("getTask", { path: { task_id: "tiles:0001-a" } })).body;
    expect(task.latest_report?.donor).toMatchObject({ id: `${HOME}/u/alice`, handle: "alice@af.test" });

    // What the home instance pulls.
    const theirs = (await host.call<{ items: Schemas["DonorStanding"][] }>("listFederatedDonors", { query: { home: HOME } })).body.items;
    expect(theirs).toEqual([expect.objectContaining({ id: `${HOME}/u/alice`, delivered: 100_000 })]);
    expect((await host.call<{ items: unknown[] }>("listFederatedDonors", { query: { home: "http://stranger.test" } })).body.items).toEqual([]);

    await syncAll(home.ctx);
    const profile = (await home.call<Schemas["Donor"]>("getDonor", { path: { handle: "alice" } })).body;
    expect(profile.elsewhere).toEqual([
      expect.objectContaining({ instance: expect.objectContaining({ base_url: HOST, host: "host.test" }), profile_url: `${HOST}/u/alice@af.test`, delivered: 100_000, tasks_delivered: 1, merged: 0 }),
    ]);
    // Shown, attributed, never summed: locally alice has delivered nothing and ranks nowhere.
    expect(profile).toMatchObject({ delivered: 0, rank: null, projects_backed: 0 });
    expect((await home.call<{ items: unknown[] }>("listDonors")).body.items).toEqual([]);
    expect((await home.call<Schemas["Stats"]>("getStats")).body.totals.delivered).toBe(0);
  });

  it("an assertion works once, for one audience, for five minutes, and only as signed", async () => {
    const bob = await home.login("bob");

    const once = await vouch(home, bob, HOST);
    expect((await redeem(host, once)).status).toBe(201);
    expect(await redeem(host, once)).toMatchObject({ status: 401, code: "assertion-invalid" });

    // For another audience.
    const elsewhere = await vouch(home, bob, "http://third.test");
    expect(await redeem(host, elsewhere)).toMatchObject({ status: 401, code: "assertion-invalid" });

    // Edited after signing: bob claims to be the home admin.
    const real = await vouch(home, bob, HOST);
    const forged = { payload: real.payload.replaceAll("bob", "home-admin"), signature: real.signature };
    expect(await redeem(host, forged)).toMatchObject({ status: 401, code: "assertion-invalid" });
    // Signed by a key that is not the one the host pinned for af.test.
    const stranger = generateKeyPair();
    const resigned = { payload: forged.payload, signature: sign(Buffer.from(forged.payload, "utf8"), stranger, "agentfund identity v1") };
    expect(await redeem(host, resigned)).toMatchObject({ status: 401, code: "assertion-invalid" });
    expect((await raw(host, "GET", `/v1/donors/${encodeURIComponent("home-admin@af.test")}`)).status).toBe(404);

    // Expired on arrival.
    const late = await vouch(home, bob, HOST);
    host.clock.advance(301);
    expect(await redeem(host, late)).toMatchObject({ status: 401, code: "assertion-invalid" });
    host.clock.advance(-301);

    expect(await redeem(host, { payload: "not json", signature: real.signature })).toMatchObject({ status: 401, code: "assertion-invalid" });
  });

  it("identity is not transitive: a federated account cannot be vouched for again", async () => {
    const carol = await home.login("carol");
    const key = (await redeem(host, await vouch(home, carol, HOST))).body.key;
    const res = await raw(host, "POST", "/v1/federation/assertions", { token: key, body: { audience: HOME } });
    expect(res).toMatchObject({ status: 403, code: "forbidden" });
    expect((await home.call("createIdentityAssertion", { token: carol, body: { audience: HOME } })).status).toBe(422);
  });

  it("a federated donor is an ordinary donor to the host: bannable, and never an admin", async () => {
    const dave = await home.login("dave");
    const key = (await redeem(host, await vouch(home, dave, HOST))).body.key;
    expect((await raw<Schemas["Me"]>(host, "GET", "/v1/me", { token: key })).body.role).toBe("donor");

    const banned = await raw(host, "PATCH", `/v1/admin/users/${encodeURIComponent("dave@af.test")}`, { token: hostAdmin, body: { banned: true } });
    expect(banned.status, JSON.stringify(banned.body)).toBe(200);
    expect((await raw(host, "GET", "/v1/me", { token: key })).code).toBe("banned");
    expect(await redeem(host, await vouch(home, dave, HOST))).toMatchObject({ status: 403, code: "banned" });
  });

  it("pausing a peer cuts its donors off at once; resuming restores them", async () => {
    const erin = await home.login("erin");
    const key = (await redeem(host, await vouch(home, erin, HOST))).body.key;
    const me = () => raw(host, "GET", "/v1/me", { token: key });
    expect((await me()).status).toBe(200);

    await raw(host, "PATCH", "/v1/admin/federation/peers/af.test", { token: hostAdmin, body: { status: "paused" } });
    expect((await me()).status).toBe(401);
    expect(await redeem(host, await vouch(home, erin, HOST))).toMatchObject({ status: 403, code: "peer-not-trusted" });
    expect((await raw<{ items: Peer[] }>(host, "GET", "/v1/federation/peers")).body.items).toEqual([]);

    await raw(host, "PATCH", "/v1/admin/federation/peers/af.test", { token: hostAdmin, body: { status: "active" } });
    expect((await me()).status).toBe(200);

    await raw(host, "PATCH", "/v1/admin/federation/peers/af.test", { token: hostAdmin, body: { accept_identities: false } });
    expect((await me()).status).toBe(401);
    await raw(host, "PATCH", "/v1/admin/federation/peers/af.test", { token: hostAdmin, body: { accept_identities: true } });
  });

  it("a peer that changes its key is quarantined until an admin pins the new one", async () => {
    const frank = await home.login("frank");
    const key = (await redeem(host, await vouch(home, frank, HOST))).body.key;
    const before = (await raw<{ items: Peer[] }>(host, "GET", "/v1/admin/federation/peers", { token: hostAdmin })).body.items[0]!;

    // The home instance now signs with (and publishes) a different key: a re-install, or an impostor.
    const next = generateKeyPair();
    await home.ctx.db.execute(sql`UPDATE instances SET pubkey = ${next.publicKey}, secret_key = ${next.secretSeed.toString("base64")} WHERE id = 1`);

    // Until the next sync the old pin still stands, so the new key's signatures are simply invalid.
    expect(await redeem(host, await vouch(home, frank, HOST))).toMatchObject({ status: 401, code: "assertion-invalid" });

    await syncAll(host.ctx);
    const quarantined = (await raw<{ items: Peer[] }>(host, "GET", "/v1/admin/federation/peers", { token: hostAdmin })).body.items[0]!;
    expect(quarantined).toMatchObject({ status: "key_mismatch", pubkey: before.pubkey, observed_pubkey: next.publicKey });
    expect(quarantined.last_error).toContain("not the pinned");
    expect(quarantined.observed_pubkey_fingerprint).toBe((await home.call<Schemas["Meta"]>("getMeta")).body.instance_pubkey_fingerprint);
    expect((await raw(host, "GET", "/v1/me", { token: key })).status).toBe(401);
    expect(await redeem(host, await vouch(home, frank, HOST))).toMatchObject({ status: 403, code: "peer-not-trusted" });
    // The mismatch is logged once, not on every tick.
    await syncAll(host.ctx);
    const logged = (await host.ctx.db.execute(sql`SELECT count(*)::int AS n FROM events WHERE action = 'peer.key_mismatch'`)) as unknown as { n: number }[];
    expect(logged[0]!.n).toBe(1);

    // "Resume" alone is refused: the admin has to say which key they now trust.
    expect((await raw(host, "PATCH", "/v1/admin/federation/peers/af.test", { token: hostAdmin, body: { status: "active" } })).status).toBe(422);
    const repinned = await raw<Peer>(host, "PATCH", "/v1/admin/federation/peers/af.test", { token: hostAdmin, body: { pubkey: next.publicKey } });
    expect(repinned.body).toMatchObject({ status: "active", pubkey: next.publicKey, observed_pubkey: null, last_error: null });
    expect((await raw(host, "GET", "/v1/me", { token: key })).status).toBe(200);
    expect((await redeem(host, await vouch(home, frank, HOST))).status).toBe(201);
  });

  it("an unreachable peer keeps its cache and says why", async () => {
    net.remove("host.test");
    const res = (await home.call<Peer>("adminSyncPeer", { token: homeAdmin, path: { host: "host.test" } })).body;
    expect(res.status).toBe("active");
    expect(res.last_error).toContain("could not reach");
    expect(res.projects).toBe(1);
    // The public listing does not carry operational detail.
    expect((await home.call<{ items: Peer[] }>("listPeers")).body.items[0]!.last_error).toBeNull();
    net.add("host.test", host);
    expect((await home.call<Peer>("adminSyncPeer", { token: homeAdmin, path: { host: "host.test" } })).body.last_error).toBeNull();
  });

  it("turning discovery off drops the cached projects; removing the peer drops everything it said", async () => {
    const off = (await home.call<Peer>("adminUpdatePeer", { token: homeAdmin, path: { host: "host.test" }, body: { discover: false } })).body;
    expect(off).toMatchObject({ discover: false, projects: 0 });
    expect((await home.call<{ items: unknown[] }>("listFederatedProjects")).body.items).toEqual([]);
    const on = (await home.call<Peer>("adminUpdatePeer", { token: homeAdmin, path: { host: "host.test" }, body: { discover: true } })).body;
    expect(on.projects).toBe(1);

    expect((await home.call("adminDeletePeer", { token: homeAdmin, path: { host: "host.test" } })).status).toBe(204);
    expect((await home.call<{ items: unknown[] }>("listFederatedProjects")).body.items).toEqual([]);
    expect((await home.call<Schemas["Donor"]>("getDonor", { path: { handle: "alice" } })).body.elsewhere).toEqual([]);
  });
});

describe("a hostile or broken peer", () => {
  let net: TestNetwork;
  let t: TestApp;
  let admin: string;
  const evil = generateKeyPair();
  const EVIL = "http://evil.test";
  let projects: unknown[] = [];
  let donors: unknown[] = [];
  let metaBaseUrl = EVIL;

  beforeAll(async () => {
    net = testNetwork();
    t = await createTestApp({ fetch: net.fetch });
    admin = await t.login("root");
    await t.login("victim");
    net.handle("evil.test", (url) => {
      if (url.pathname === "/v1/meta") {
        return Response.json({
          app: "AgentFund", name: "Evil", version: "9.9.9", base_url: metaBaseUrl, protocol_versions: ["v1"], spec_versions: [1], instance_pubkey: evil.publicKey,
          capabilities: { github_oauth: false, dev_login: false, sse: true, ci_providers: ["generic"], ci_poll: false, federation: true },
        });
      }
      if (url.pathname === "/v1/federation/peers") return Response.json({ items: [] });
      if (url.pathname === "/v1/projects") return Response.json({ items: projects, next_cursor: null });
      if (url.pathname === "/v1/federation/donors") return Response.json({ items: donors, next_cursor: null });
      return new Response("nope", { status: 404 });
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it("cannot be added under a URL other than the one it claims, nor without being an instance", async () => {
    metaBaseUrl = "http://somewhere-else.test";
    expect((await t.call("adminPreviewPeer", { token: admin, body: { base_url: EVIL } })).code).toBe("peer-unverifiable");
    metaBaseUrl = EVIL;
    net.handle("blog.test", () => Response.json({ hello: "world" }));
    expect((await t.call("adminPreviewPeer", { token: admin, body: { base_url: "http://blog.test" } })).code).toBe("peer-unverifiable");
    net.handle("hop.test", () => Response.redirect(`${EVIL}/v1/meta`, 302));
    expect((await t.call("adminPreviewPeer", { token: admin, body: { base_url: "http://hop.test" } })).code).toBe("peer-unverifiable");
    for (const bad of ["ftp://evil.test", "http://user:pw@evil.test", "http://af.test", "http://evil.test/?x=1"]) {
      expect((await t.call("adminPreviewPeer", { token: admin, body: { base_url: bad } })).status, bad).toBe(422);
    }
  });

  it("cannot credit work to donors it was never given, nor inject malformed projects", async () => {
    const standing = { pledged: 0, reported: 9, delivered: 9, merged: 9, tasks_delivered: 9, tasks_merged: 9, avatar_url: null };
    donors = [
      { ...standing, id: "http://af.test/u/victim", handle: "victim@af.test" },
      { ...standing, id: "http://af.test/u/nobody", handle: "nobody@af.test" },
      { ...standing, id: "http://other.test/u/victim", handle: "victim@other.test" },
      { ...standing, id: "http://af.test/u/victim/../root", handle: "x" },
      { id: "http://af.test/u/root", handle: "root@af.test", delivered: "lots" },
      { ...standing, id: "http://af.test/u/root", handle: "root@af.test", delivered: 1e30 },
      { ...standing, id: "http://af.test/u/root", handle: "root@af.test", merged: -5 },
      { ...standing, id: "http://af.test/u/root", handle: "root@af.test", tasks_merged: 5e9 },
    ];
    projects = [{ slug: "../../admin", name: "x" }, { nonsense: true }, "string"];
    const preview = (await t.call<Schemas["PeerPreview"]>("adminPreviewPeer", { token: admin, body: { base_url: EVIL } })).body;
    const added = (await t.call<Peer>("adminCreatePeer", { token: admin, body: { base_url: EVIL, pubkey: preview.pubkey } })).body;
    expect(added).toMatchObject({ status: "active", projects: 0, last_error: null });
    // Only the claim about a real local donor is kept, and it stays the peer's claim.
    const victim = (await t.call<Schemas["Donor"]>("getDonor", { path: { handle: "victim" } })).body;
    expect(victim.elsewhere).toHaveLength(1);
    expect(victim.elsewhere![0]).toMatchObject({ instance: { host: "evil.test" }, delivered: 9 });
    expect(victim).toMatchObject({ delivered: 0, merged: 0, rank: null });
    expect((await t.call<Schemas["Donor"]>("getDonor", { path: { handle: "root" } })).body.elsewhere).toEqual([]);
  });

  it("cannot admit donors: nobody turned accept_identities on for it", async () => {
    const payload = JSON.stringify({ type: "agentfund-identity-v1", iss: EVIL, sub: `${EVIL}/u/mallory`, handle: "mallory", avatar_url: null, aud: "http://af.test", iat: t.clock.now().toISOString(), exp: new Date(t.clock.now().getTime() + 60_000).toISOString(), jti: "j".repeat(32) });
    const assertion = { payload, signature: sign(Buffer.from(payload, "utf8"), evil, "agentfund identity v1") };
    expect((await t.call("authFederated", { body: { assertion } })).code).toBe("peer-not-trusted");

    // Even when trusted, it can only speak for its own users, in handles that are valid ones.
    await t.call("adminUpdatePeer", { token: admin, path: { host: "evil.test" }, body: { accept_identities: true } });
    const mint = (over: Record<string, unknown>) => {
      const p = JSON.stringify({ ...JSON.parse(payload), jti: Math.random().toString(36).repeat(3), ...over });
      return { payload: p, signature: sign(Buffer.from(p, "utf8"), evil, "agentfund identity v1") };
    };
    expect((await t.call("authFederated", { body: { assertion: mint({ sub: "http://af.test/u/root" }) } })).code).toBe("assertion-invalid");
    expect((await t.call("authFederated", { body: { assertion: mint({ handle: "root@af.test" }) } })).code).toBe("assertion-invalid");
    expect((await t.call("authFederated", { body: { assertion: mint({ exp: new Date(t.clock.now().getTime() + 86_400_000).toISOString() }) } })).code).toBe("assertion-invalid");
    expect((await t.call("authFederated", { body: { assertion: mint({ iat: new Date(t.clock.now().getTime() + 3_600_000).toISOString(), exp: new Date(t.clock.now().getTime() + 3_700_000).toISOString() }) } })).code).toBe("assertion-invalid");
    const ok = await t.call<{ user: Schemas["Me"] }>("authFederated", { body: { assertion: mint({ avatar_url: "javascript:alert(1)" }) } });
    expect(ok.status).toBe(201);
    expect(ok.body.user).toMatchObject({ handle: "mallory@evil.test", role: "donor", avatar_url: null });
  });
});

describe("first-user bootstrap", () => {
  it("a federated donor arriving first does not take, or block, the admin seat", async () => {
    const net = testNetwork();
    const a = await createTestApp({ fetch: net.fetch });
    const b = await createTestApp({ fetch: net.fetch, env: { BASE_URL: HOST } });
    net.add("af.test", a);
    net.add("host.test", b);
    try {
      const user = await b.login("first-on-b");
      // Peer directly in the database: instance `a` has no admin yet, which is the point.
      const meta = (await raw<Schemas["Meta"]>(b, "GET", "/v1/meta")).body;
      await a.ctx.db.execute(sql`INSERT INTO peers (base_url, host, name, pubkey, accept_identities, added_at) VALUES (${HOST}, 'host.test', 'B', ${meta.instance_pubkey!}, true, now())`);
      const admitted = await a.call<{ user: Schemas["Me"] }>("authFederated", { body: { assertion: await vouch(b, user, HOME) } });
      expect(admitted.body.user.role).toBe("donor");
      const local = await a.call<{ user: Schemas["Me"] }>("authDev", { body: { handle: "operator" } });
      expect(local.body.user.role).toBe("admin");
    } finally {
      await b.close();
      await a.close();
    }
  });
});

describe("FEDERATION=false", () => {
  it("serves none of it and says so in meta", async () => {
    const t = await createTestApp({ env: { FEDERATION: "false" } });
    try {
      const admin = await t.login("root");
      expect((await t.call<Schemas["Meta"]>("getMeta")).body.capabilities.federation).toBe(false);
      expect((await t.call("listPeers")).status).toBe(404);
      expect((await t.call("listFederatedProjects")).status).toBe(404);
      expect((await t.call("listFederatedDonors", { query: { home: HOST } })).status).toBe(404);
      expect((await t.call("createIdentityAssertion", { token: admin, body: { audience: HOST } })).status).toBe(404);
      expect((await t.call("authFederated", { body: { assertion: { payload: "{}", signature: "x" } } })).status).toBe(404);
      expect((await t.call("adminListPeers", { token: admin })).status).toBe(404);
      expect((await t.call<Schemas["Donor"]>("getDonor", { path: { handle: "root" } })).body.elsewhere).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
