/**
 * OpenAPI contract: every operation in spec/openapi.yaml is exercised against a real
 * Postgres, and every response (status + body) is validated against the document by the
 * `call` helper. Also: the router and the document expose exactly the same /v1 routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signBody } from "../src/ci/adapter.js";
import type { OperationId, Schemas } from "../src/lib/openapi.js";
import { indexAll } from "../src/services/indexer.js";
import { createTestApp, projectSecret, type TestApp } from "./helpers/app.js";
import { raw, testNetwork } from "./helpers/network.js";
import { TestRepo } from "./helpers/repo.js";
import { completedBody, DIGEST } from "./helpers/scenario.js";

let t: TestApp;
let peer: TestApp;
const fakeGithub: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "gho_x" });
  if (url.endsWith("/user")) return Response.json({ id: 42, login: "contract-gh", email: "c@example.com", avatar_url: null });
  return Response.json([]);
};

beforeAll(async () => {
  const net = testNetwork(fakeGithub);
  t = await createTestApp({ fetch: net.fetch, env: { GITHUB_CLIENT_ID: "client", GITHUB_CLIENT_SECRET: "client-secret" } });
  peer = await createTestApp({ fetch: net.fetch, env: { BASE_URL: "http://peer.test" } });
  net.add("af.test", t);
  net.add("peer.test", peer);
});
afterAll(async () => {
  await peer.close();
  await t.close();
});

describe("router ↔ OpenAPI parity", () => {
  it("every operation in the document has a handler", () => {
    const documented = [...t.ctx.spec.operations.keys()].sort();
    expect(documented.length).toBe(50);
    expect([...t.app.operations].sort()).toEqual(documented);
  });

  it("the router exposes no /v1 route that the document does not describe, and vice versa", () => {
    const documented = new Set([...t.ctx.spec.operations.values()].map((o) => `${o.method.toUpperCase()} ${o.route}`));
    const routed = new Set(
      t.app.hono.routes
        .filter((r) => r.path.startsWith("/v1") && r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`),
    );
    expect([...routed].sort()).toEqual([...documented].sort());
    // The only catch-alls under /v1 are the 404 problem handlers.
    expect(t.app.hono.routes.filter((r) => r.path.startsWith("/v1") && r.method === "ALL").map((r) => r.path).sort()).toEqual(["/v1", "/v1/*"]);
  });

  it("every documented path parameter pattern is enforced (non-matching ids are 404, not 500)", async () => {
    const admin = await t.login("root");
    const key = await t.apiKey(admin);
    expect((await t.call("getProject", { path: { slug: "Not_A_Slug" } })).status).toBe(404);
    expect((await t.call("getDonor", { path: { handle: "UPPER" } })).status).toBe(404);
    expect((await t.call("claimTask", { token: key, path: { task_id: "no-colon" } })).status).toBe(404);
    expect((await t.call("heartbeatClaim", { token: key, path: { claim_id: "clm_x" } })).status).toBe(404);
    expect((await t.call("reportClaim", { token: key, path: { claim_id: "rep_aaaaaaaaaaaaaaaaaaaa" }, body: {} })).status).toBe(404);
  });
});

describe("every operation, validated against the document", () => {
  it("walks the whole API once", async () => {
    const repo = TestRepo.create([{ id: "0001-a" }, { id: "0002-b", depends_on: ["0001-a"] }, { id: "0003-c" }], { name: "contract" });
    const slug = "contract";

    // auth
    const dev = await t.call<{ token: string; user: Schemas["Me"] }>("authDev", { body: { handle: "root" } });
    const admin = dev.body.token;
    const start = await t.call("authGithubStart", { query: { redirect: "/welcome" } });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    expect((await t.call("authGithubCallback", { query: { code: "c", state } })).status).toBe(302);
    expect((await t.call("authGithubCallback", {})).status).toBe(400);
    await t.call("getMe", { token: admin });
    await t.call("getMe");
    const key = (await t.call<Schemas["ApiKey"] & { key: string }>("createApiKey", { token: admin, body: { label: "worker" } })).body;
    const spare = (await t.call<Schemas["ApiKey"] & { key: string }>("createApiKey", { token: admin, body: { label: "spare" } })).body;
    await t.call("createApiKey", { body: { label: "x" } });
    await t.call("listApiKeys", { token: admin });
    await t.call("listApiKeys");
    expect((await t.call("revokeApiKey", { token: admin, path: { key_id: spare.id } })).status).toBe(204);
    await t.call("revokeApiKey", { token: admin, path: { key_id: "key_missing" } });
    await t.call("revokeApiKey", { path: { key_id: spare.id } });

    // meta
    const meta = (await t.call<Schemas["Meta"]>("getMeta")).body;
    expect(meta).toMatchObject({ app: "AgentFund", base_url: "http://af.test", protocol_versions: ["v1"], spec_versions: [1] });
    expect(meta.links).toEqual({ source_url: "https://github.com/ghvstcode/agentfund", install_command: "curl -fsSL https://raw.githubusercontent.com/ghvstcode/agentfund/main/scripts/install.sh | sh" });
    expect(meta.instance_pubkey).toMatch(/^[A-Za-z0-9+/]{56}$/);
    expect(Buffer.from(meta.instance_pubkey!, "base64").subarray(0, 2).toString()).toBe("Ed");
    await t.call("getStats");

    // maintain
    expect((await t.call<Schemas["ProjectPreview"]>("previewProject", { token: admin, body: { repo_url: repo.url } })).body.ok).toBe(true);
    await t.call("previewProject", { token: admin, body: {} });
    await t.call("previewProject", { body: { repo_url: repo.url } });
    expect((await t.call("createProject", { token: admin, body: { repo_url: repo.url, slug } })).status).toBe(201);
    await t.call("createProject", { body: { repo_url: repo.url } });
    expect((await t.call("createProject", { token: admin, body: { repo_url: repo.url, slug: "again" } })).status).toBe(409);
    expect((await t.call("createProject", { token: admin, body: { repo_url: 5 } })).status).toBe(422);
    expect((await t.call("updateProject", { token: admin, path: { slug }, body: { token_goal: 5_000_000 } })).status).toBe(200);
    await t.call("updateProject", { path: { slug }, body: {} });
    await t.call("updateProject", { token: admin, path: { slug: "missing" }, body: {} });
    const outsider = await t.login("outsider");
    expect((await t.call("updateProject", { token: outsider, path: { slug }, body: {} })).status).toBe(403);
    expect((await t.call("repinProject", { token: admin, path: { slug } })).status).toBe(200);
    expect((await t.call("repinProject", { token: admin, path: { slug }, body: { commit: repo.head() } })).status).toBe(200);
    await t.call("repinProject", { path: { slug } });
    await t.call("repinProject", { token: outsider, path: { slug } });
    await t.call("repinProject", { token: admin, path: { slug: "missing" } });
    expect((await t.call("repinProject", { token: admin, path: { slug }, body: { commit: "0".repeat(40) } })).status).toBe(422);

    // work
    expect((await t.call("createPledge", { token: key.key, path: { slug }, body: { token_amount: 1_000_000 } })).status).toBe(201);
    expect((await t.call("createPledge", { token: admin, path: { slug }, body: { token_amount: 1 } })).status).toBe(201);
    await t.call("createPledge", { path: { slug }, body: { token_amount: 1 } });
    await t.call("createPledge", { token: admin, path: { slug: "missing" }, body: { token_amount: 1 } });
    expect((await t.call("createPledge", { token: admin, path: { slug }, body: { token_amount: 0 } })).status).toBe(422);

    const c1 = (await t.call<Schemas["Claim"]>("claimTask", { token: key.key, path: { task_id: `${slug}:0001-a` } })).body;
    await t.call("claimTask", { path: { task_id: `${slug}:0001-a` } });
    await t.call("claimTask", { token: key.key, path: { task_id: `${slug}:0009-missing` } });
    expect((await t.call("claimTask", { token: key.key, path: { task_id: `${slug}:0001-a` } })).status).toBe(409);
    expect((await t.call("claimTask", { token: key.key, path: { task_id: `${slug}:0002-b` } })).status).toBe(409);

    expect((await t.call("heartbeatClaim", { token: key.key, path: { claim_id: c1.claim_id }, body: { tokens_in: 10, tokens_out: 2, phase: "agent" } })).status).toBe(200);
    expect((await t.call("heartbeatClaim", { token: key.key, path: { claim_id: c1.claim_id } })).status).toBe(200);
    await t.call("heartbeatClaim", { path: { claim_id: c1.claim_id } });
    await t.call("heartbeatClaim", { token: key.key, path: { claim_id: "clm_aaaaaaaaaaaaaaaaaaaa" } });
    expect((await t.call("heartbeatClaim", { token: key.key, path: { claim_id: c1.claim_id }, body: { phase: "napping" } })).status).toBe(422);
    const otherKey = await t.apiKey(outsider);
    expect((await t.call("heartbeatClaim", { token: otherKey, path: { claim_id: c1.claim_id } })).status).toBe(403);

    await t.call("listMyClaims", { token: key.key, query: { active: true, limit: 10 } });
    await t.call("listMyClaims");

    const report = (await t.call<Schemas["Report"]>("reportClaim", { token: key.key, path: { claim_id: c1.claim_id }, body: completedBody(c1) })).body;
    expect((await t.call("reportClaim", { token: key.key, path: { claim_id: c1.claim_id }, body: completedBody(c1) })).status).toBe(409);
    await t.call("reportClaim", { path: { claim_id: c1.claim_id }, body: completedBody(c1) });
    await t.call("reportClaim", { token: otherKey, path: { claim_id: c1.claim_id }, body: completedBody(c1) });
    await t.call("reportClaim", { token: key.key, path: { claim_id: "clm_aaaaaaaaaaaaaaaaaaaa" }, body: completedBody(c1) });
    expect((await t.call("reportClaim", { token: key.key, path: { claim_id: c1.claim_id }, body: { status: "nope" } })).status).toBe(422);
    expect((await t.call("heartbeatClaim", { token: key.key, path: { claim_id: c1.claim_id } })).status).toBe(409);
    await t.call("listMyClaims", { token: admin });

    const c3 = (await t.call<Schemas["Claim"]>("claimTask", { token: key.key, path: { task_id: `${slug}:0003-c` } })).body;
    await t.call("releaseClaim", { path: { claim_id: c3.claim_id } });
    await t.call("releaseClaim", { token: otherKey, path: { claim_id: c3.claim_id } });
    await t.call("releaseClaim", { token: key.key, path: { claim_id: "clm_aaaaaaaaaaaaaaaaaaaa" } });
    expect((await t.call("releaseClaim", { token: key.key, path: { claim_id: c3.claim_id }, body: { reason: "policy", tokens_in: 5, tokens_out: 1 } })).status).toBe(204);
    expect((await t.call("releaseClaim", { token: key.key, path: { claim_id: c3.claim_id } })).status).toBe(409);
    const c3b = (await t.call<Schemas["Claim"]>("claimTask", { token: key.key, path: { task_id: `${slug}:0003-c` } })).body;
    await t.call("reportClaim", { token: key.key, path: { claim_id: c3b.claim_id }, body: { status: "failed", tokens_in: 3, tokens_out: 4, cost_estimate: 0.01, log_digest: DIGEST, message: "tests failed" } });

    // webhooks
    const hookCfg = await t.call<Schemas["ProjectWebhook"]>("getProjectWebhook", { token: admin, path: { slug } });
    expect(hookCfg.status).toBe(200);
    await t.call("getProjectWebhook", { path: { slug } });
    await t.call("getProjectWebhook", { token: outsider, path: { slug } });
    await t.call("getProjectWebhook", { token: admin, path: { slug: "missing" } });
    const rotated = await t.call<Schemas["ProjectWebhook"]>("rotateProjectWebhook", { token: admin, path: { slug } });
    expect(rotated.status).toBe(200);
    await t.call("rotateProjectWebhook", { path: { slug } });
    await t.call("rotateProjectWebhook", { token: outsider, path: { slug } });
    await t.call("rotateProjectWebhook", { token: admin, path: { slug: "missing" } });
    expect(await projectSecret(t, repo.url)).toBe(rotated.body.secret);
    const ci = JSON.stringify({ provider: "generic", repo_url: repo.url, branch: report.branch, head_sha: report.head_sha, conclusion: "success", run_url: "https://ci.example/1", merged: true });
    expect((await t.call("ciWebhook", { raw: ci, headers: { "x-agentfund-signature": signBody(hookCfg.body.secret, ci) } })).status).toBe(401);
    const hook = await t.call<{ matched: boolean }>("ciWebhook", { raw: ci, headers: { "x-agentfund-signature": signBody(rotated.body.secret, ci) } });
    expect(hook.status).toBe(202);
    expect(hook.body.matched).toBe(true);
    expect((await t.call("ciWebhook", { raw: ci })).status).toBe(401);
    const invalid = JSON.stringify({ provider: "generic", repo_url: repo.url });
    expect((await t.call("ciWebhook", { raw: invalid, headers: { "x-agentfund-signature": signBody(rotated.body.secret, invalid) } })).status).toBe(422);

    // public reads, now with every kind of row present
    const projects = (await t.call<{ items: Schemas["Project"][] }>("listProjects", { query: { q: "contract", sort: "delivered", status: "active", needs_donors: true, limit: 10 } })).body.items;
    expect(projects).toHaveLength(1);
    await t.call("listProjects", { query: { tag: "demo", language: "python", maintainer: "root", sort: "active" } });
    await t.call("listProjects", { query: { limit: 0 } });
    await t.call("getProject", { path: { slug } });
    await t.call("getProject", { path: { slug: "missing" } });
    const tasks = (await t.call<{ items: Schemas["Task"][]; next_cursor: string | null }>("listTasks", { path: { slug }, query: { limit: 2 } })).body;
    expect(tasks.items.map((x) => x.state)).toEqual(["merged", "open"]);
    expect(tasks.items[0]!.latest_report).toMatchObject({ delivery: "merged" });
    await t.call("listTasks", { path: { slug }, query: { cursor: tasks.next_cursor!, state: "open", claimable: true } });
    await t.call("listTasks", { path: { slug }, query: { state: "sideways" } });
    await t.call("listTasks", { path: { slug: "missing" } });
    const one = await t.call<Schemas["Task"]>("getTask", { path: { task_id: `${slug}:0001-a` } });
    expect(one.status).toBe(200);
    expect(one.body).toEqual(tasks.items[0]);
    expect((await t.call("getTask", { path: { task_id: `${slug}:0009-missing` } })).status).toBe(404);
    expect((await t.call("getTask", { path: { task_id: "missing:0001-a" } })).status).toBe(404);
    expect((await t.call("getTask", { path: { task_id: "not-a-task-id" } })).status).toBe(404);
    // The dependent opens once the branch, which now holds the merge, has been read again.
    repo.write("src/a.py", "# 0001-a\n");
    repo.commit("Merge 0001-a");
    t.clock.advance(1);
    await indexAll(t.ctx);
    const c2 = (await t.call<Schemas["Claim"]>("claimTask", { token: key.key, path: { task_id: `${slug}:0002-b` } })).body;
    await t.call("heartbeatClaim", { token: key.key, path: { claim_id: c2.claim_id }, body: { tokens_in: 1, tokens_out: 1, phase: "sandbox" } });
    const withClaim = (await t.call<{ items: Schemas["Task"][] }>("listTasks", { path: { slug }, query: { state: "claimed" } })).body.items;
    expect(withClaim[0]!.active_claim).toMatchObject({ tokens_so_far: 2, phase: "sandbox" });
    const ledger = (await t.call<Schemas["Ledger"]>("getLedger", { path: { slug }, query: { limit: 3 } })).body;
    expect(ledger.entries).toHaveLength(3);
    const full = (await t.call<Schemas["Ledger"]>("getLedger", { path: { slug }, query: { limit: 100 } })).body.entries;
    expect(full.find((e) => e.type === "report" && e.report_status === "completed")?.delivery).toBe("merged");
    expect(full.find((e) => e.type === "report" && e.report_status === "failed")?.delivery).toBe("none");
    expect(full.find((e) => e.report_status === "released")?.delivery).toBeNull();
    expect(full.filter((e) => e.type !== "report").every((e) => e.delivery === null)).toBe(true);
    const proj = (await t.call<Schemas["Project"]>("getProject", { path: { slug } })).body;
    expect(proj.commit_url).toBeNull(); // file:// repo: no browser URL
    expect(proj.lock_url).toBeNull();
    await t.call("getLedger", { path: { slug }, query: { cursor: ledger.next_cursor! } });
    await t.call("getLedger", { path: { slug: "missing" } });
    await t.call("listProjectEvents", { path: { slug }, query: { limit: 5 } });
    await t.call("listProjectEvents", { path: { slug: "missing" } });
    await t.call("listEvents", { query: { limit: 5 } });
    await t.call("listDonors");
    expect((await t.call<Schemas["Donor"]>("getDonor", { path: { handle: "root" } })).body).toMatchObject({ handle: "root", rank: 1, tasks_merged: 1 });
    await t.call("getDonor", { path: { handle: "missing" } });

    // live
    const stream = await t.call<Response>("stream", { query: { project: slug } });
    expect(stream.status).toBe(200);
    await stream.body.body?.cancel();
    await t.call("stream", { query: { project: "missing" } });

    // admin
    await t.call("adminListUsers", { token: admin, query: { q: "out", limit: 5 } });
    await t.call("adminListUsers", { token: outsider });
    expect((await t.call("adminUpdateUser", { token: admin, path: { handle: "outsider" }, body: { role: "maintainer", banned: false } })).status).toBe(200);
    await t.call("adminUpdateUser", { token: outsider, path: { handle: "root" }, body: { banned: true } });
    await t.call("adminUpdateUser", { token: admin, path: { handle: "missing" }, body: { banned: true } });
    await t.call("adminListProjects", { token: admin, query: { limit: 5 } });
    await t.call("adminListProjects", { token: outsider });
    expect((await t.call("adminUpdateProject", { token: admin, path: { slug }, body: { status: "paused" } })).status).toBe(200);
    expect((await t.call("createPledge", { token: admin, path: { slug }, body: { token_amount: 1 } })).status).toBe(409);
    await t.call("adminUpdateProject", { token: outsider, path: { slug }, body: { status: "removed" } });
    await t.call("adminUpdateProject", { token: admin, path: { slug: "missing" }, body: { status: "active" } });
    expect((await t.call("adminUpdateProject", { token: admin, path: { slug }, body: {} })).status).toBe(422);
    await t.call("adminGetInstance", { token: admin });
    await t.call("adminGetInstance", { token: outsider });
    expect((await t.call("adminUpdateInstance", { token: admin, body: { description: "A contract-tested instance." } })).status).toBe(200);
    await t.call("adminUpdateInstance", { token: outsider, body: {} });
    expect((await t.call("authDev", { body: { handle: "x", extra: 1 } })).status).toBe(422);

    // federation: peer.test is a second real instance on the same in-process network
    const PEER = "http://peer.test";
    const host = "peer.test";
    const preview = (await t.call<Schemas["PeerPreview"]>("adminPreviewPeer", { token: admin, body: { base_url: `${PEER}/` } })).body;
    expect(preview).toMatchObject({ base_url: PEER, host, federation: true });
    await t.call("adminPreviewPeer", { token: outsider, body: { base_url: PEER } });
    expect((await t.call("adminPreviewPeer", { token: admin, body: { base_url: "http://nowhere.test" } })).code).toBe("peer-unverifiable");
    expect((await t.call("adminCreatePeer", { token: admin, body: { base_url: PEER, pubkey: meta.instance_pubkey } })).code).toBe("peer-unverifiable");
    const added = await t.call<Schemas["Peer"]>("adminCreatePeer", { token: admin, body: { base_url: PEER, pubkey: preview.pubkey } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ host, status: "active", discover: true, accept_identities: false, accepts_us: false, last_error: null });
    expect((await t.call("adminCreatePeer", { token: admin, body: { base_url: PEER, pubkey: preview.pubkey } })).code).toBe("peer-exists");
    await t.call("adminCreatePeer", { token: outsider, body: { base_url: PEER, pubkey: preview.pubkey } });

    const visitor = await peer.login("visitor");
    const vouch = async () => (await raw<{ assertion: Schemas["SignedDocument"] }>(peer, "POST", "/v1/federation/assertions", { token: visitor, body: { audience: "http://af.test" } })).body.assertion;
    expect((await t.call("authFederated", { body: { assertion: await vouch() } })).code).toBe("peer-not-trusted");
    expect((await t.call<Schemas["Peer"]>("adminUpdatePeer", { token: admin, path: { host }, body: { accept_identities: true } })).body.accept_identities).toBe(true);
    await t.call("adminUpdatePeer", { token: outsider, path: { host }, body: {} });
    await t.call("adminUpdatePeer", { token: admin, path: { host: "missing.test" }, body: {} });
    const assertion = await vouch();
    const fed = await t.call<{ key: string; user: Schemas["Me"] }>("authFederated", { body: { assertion, label: "contract" } });
    expect(fed.status).toBe(201);
    expect(fed.body.user).toMatchObject({ id: `${PEER}/u/visitor`, handle: "visitor@peer.test", role: "donor" });
    expect((await t.call("authFederated", { body: { assertion } })).code).toBe("assertion-invalid");
    expect((await t.call("authFederated", { body: {} })).status).toBe(422);
    expect((await t.call<Schemas["Me"]>("getMe", { token: fed.body.key })).body.handle).toBe("visitor@peer.test");

    expect((await t.call("createIdentityAssertion", { token: admin, body: { audience: PEER } })).status).toBe(201);
    await t.call("createIdentityAssertion", { body: { audience: PEER } });
    expect((await t.call("createIdentityAssertion", { token: fed.body.key, body: { audience: PEER } })).status).toBe(403);
    expect((await t.call("createIdentityAssertion", { token: admin, body: { audience: "not a url" } })).status).toBe(422);

    expect((await t.call<{ items: Schemas["Peer"][] }>("listPeers")).body.items.map((p) => p.host)).toEqual([host]);
    await t.call("listFederatedProjects", { query: { q: "x", peer: host } });
    await t.call("listFederatedDonors", { query: { home: PEER } });
    expect((await t.call<{ items: Schemas["Peer"][] }>("adminListPeers", { token: admin })).body.items[0]).toMatchObject({ host, donors: 1 });
    await t.call("adminListPeers", { token: outsider });
    expect((await t.call<Schemas["Peer"]>("adminSyncPeer", { token: admin, path: { host } })).body.last_error).toBeNull();
    await t.call("adminSyncPeer", { token: outsider, path: { host } });
    await t.call("adminSyncPeer", { token: admin, path: { host: "missing.test" } });
    await t.call("adminDeletePeer", { token: outsider, path: { host } });
    await t.call("adminDeletePeer", { token: admin, path: { host: "missing.test" } });
    expect((await t.call("adminDeletePeer", { token: admin, path: { host } })).status).toBe(204);
    // With the peer gone, the donor it vouched for no longer resolves.
    expect((await t.call("getMe", { token: fed.body.key })).status).toBe(401);

    expect((await t.call("authLogout", { token: admin })).status).toBe(204);

    // Coverage: every operation answered at least once with a documented success status,
    // and every (operation, status) the document lists was actually produced.
    const missing: string[] = [];
    for (const op of t.ctx.spec.operations.values()) {
      for (const status of Object.keys(op.raw.responses)) {
        if (!t.seen.has(`${op.id} ${status}`)) missing.push(`${op.id} ${status}`);
      }
    }
    // dev login 404 needs a differently configured instance; covered in auth.test.ts.
    // The federation 404s are the answers of an instance with FEDERATION=false; covered in federation.test.ts.
    // The push-access 403 needs GitHub sign-in instead of dev login; covered in registration.test.ts.
    expect(missing.sort()).toEqual([
      "adminListPeers 404", "authDev 404", "authFederated 404", "authGithubStart 404", "createIdentityAssertion 404", "createProject 403",
      "listFederatedDonors 404", "listFederatedProjects 404", "listPeers 404", "previewProject 403",
    ]);
    const undocumented = [...t.seen].filter((s) => {
      const [id, status] = s.split(" ") as [OperationId, string];
      return !(status in t.ctx.spec.operation(id).raw.responses);
    });
    // Statuses the server can answer that the document does not list for that operation.
    // Each is a deliberate, RFC 9457-shaped answer (see the spec notes in docs/self-hosting.md).
    expect(undocumented.sort()).toEqual(
      [
        "adminGetInstance 401", "adminListProjects 401", "adminListUsers 401", "adminUpdateInstance 401", "adminUpdateInstance 422",
        "adminUpdateProject 401", "adminUpdateProject 422", "adminUpdateUser 401", "adminUpdateUser 422",
        "adminCreatePeer 401", "adminDeletePeer 401", "adminListPeers 401", "adminPreviewPeer 401", "adminSyncPeer 401", "adminUpdatePeer 401", "adminUpdatePeer 422",
        "listFederatedDonors 422", "listFederatedProjects 422",
        "authDev 403", "authDev 422", "authGithubStart 422", "authLogout 401",
        "createPledge 422", "getLedger 422", "heartbeatClaim 422", "listDonors 422", "listEvents 422", "listProjectEvents 422",
        "listProjects 422", "listTasks 422", "releaseClaim 422", "stream 404", "updateProject 422",
      ].filter((s) => t.seen.has(s)).sort(),
    );
  });
});
