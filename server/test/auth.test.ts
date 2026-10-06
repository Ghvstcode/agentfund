import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/ids.js";
import type { Schemas } from "../src/lib/openapi.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { setupProject } from "./helpers/scenario.js";

type Me = Schemas["Me"];
type ApiKey = Schemas["ApiKey"];

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe("sessions and dev login", () => {
  it("the first user becomes admin, later users are donors; tokens are stored hashed", async () => {
    const first = await t.call<{ token: string; user: Me }>("authDev", { body: { handle: "founder" } });
    expect(first.body.user).toMatchObject({ id: "http://af.test/u/founder", handle: "founder", role: "admin", banned: false });
    expect(first.body.token).toMatch(/^afs_[A-Za-z0-9_-]{43}$/);
    const second = await t.call<{ token: string; user: Me }>("authDev", { body: { handle: "newcomer" } });
    expect(second.body.user.role).toBe("donor");
    // Logging in again is the same user with a new session.
    const again = await t.call<{ token: string; user: Me }>("authDev", { body: { handle: "newcomer" } });
    expect(again.body.user.created_at).toBe(second.body.user.created_at);
    expect(again.body.token).not.toBe(second.body.token);

    const stored = (await t.ctx.db.execute(sql`SELECT token_hash FROM sessions`)) as unknown as { token_hash: string }[];
    expect(stored.map((s) => s.token_hash)).toContain(sha256Hex(first.body.token));
    expect(JSON.stringify(stored)).not.toContain(first.body.token);

    expect((await t.call<Me>("getMe", { token: first.body.token })).body.handle).toBe("founder");
    expect((await t.call("authDev", { body: { handle: "Not Valid!" } })).status).toBe(422);
    expect((await t.call("authDev", { body: {} })).status).toBe(422);
    expect((await t.call("authDev", { raw: "{" })).status).toBe(422);
  });

  it("rejects missing, malformed, unknown and expired credentials with 401", async () => {
    for (const token of [null, "afs_unknown", "af_unknown", "garbage"]) {
      const r = await t.call("getMe", { token });
      expect(r.status).toBe(401);
      expect(r.code).toBe("unauthorized");
    }
    expect((await t.call("getMe", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    const token = await t.login("sleepy");
    t.clock.advance(31 * 86_400);
    expect((await t.call("getMe", { token })).status).toBe(401);
    t.clock.advance(-31 * 86_400);
    expect((await t.call("getMe", { token })).status).toBe(200);
  });

  it("logout revokes the session", async () => {
    const token = await t.login("leaver");
    expect((await t.call("authLogout", { token })).status).toBe(204);
    expect((await t.call("getMe", { token })).status).toBe(401);
  });

  it("dev login answers 404 when the capability is off", async () => {
    const off = await createTestApp({ env: { AUTH_DEV_LOGIN: "false" } });
    try {
      expect((await off.call("authDev", { body: { handle: "anyone" } })).status).toBe(404);
      expect((await off.call<Schemas["Meta"]>("getMeta")).body.capabilities.dev_login).toBe(false);
    } finally {
      await off.close();
    }
  });

  it("ADMIN_HANDLES decides who is admin instead of first-come", async () => {
    const a = await createTestApp({ env: { ADMIN_HANDLES: "boss, Chief" } });
    try {
      expect((await a.call<{ user: Me }>("authDev", { body: { handle: "early-bird" } })).body.user.role).toBe("donor");
      expect((await a.call<{ user: Me }>("authDev", { body: { handle: "boss" } })).body.user.role).toBe("admin");
      expect((await a.call<{ user: Me }>("authDev", { body: { handle: "chief" } })).body.user.role).toBe("admin");
    } finally {
      await a.close();
    }
  });
});

describe("API keys", () => {
  it("are minted once, stored as SHA-256, listed without the secret, and die on revocation", async () => {
    const session = await t.login("keeper");
    const made = await t.call<ApiKey & { key: string }>("createApiKey", { token: session, body: { label: "laptop" } });
    expect(made.status).toBe(201);
    const { key, id, prefix } = made.body;
    expect(key).toMatch(/^af_[A-Za-z0-9_-]{43}$/);
    expect(id).toMatch(/^key_/);
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(key.length / 2);

    const row = (await t.ctx.db.execute(sql`SELECT key_hash, prefix FROM api_keys WHERE public_id = ${id}`)) as unknown as { key_hash: string }[];
    expect(row[0]!.key_hash).toBe(sha256Hex(key));
    const dump = JSON.stringify(await t.ctx.db.execute(sql`SELECT * FROM api_keys`));
    expect(dump).not.toContain(key);

    const me = await t.call<Me>("getMe", { token: key });
    expect(me.body.handle).toBe("keeper");
    const list = await t.call<{ items: (ApiKey & { key?: string })[] }>("listApiKeys", { token: session });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id, label: "laptop", revoked_at: null });
    expect(list.body.items[0]!.key).toBeUndefined();
    expect(list.body.items[0]!.last_used_at).not.toBeNull();

    // Key management needs a session; an API key cannot mint or list keys.
    expect((await t.call("createApiKey", { token: key, body: { label: "x" } })).status).toBe(401);
    expect((await t.call("listApiKeys", { token: key })).status).toBe(401);
    expect((await t.call("createApiKey", { token: session, body: { label: "" } })).status).toBe(422);
    expect((await t.call("createApiKey", { token: session, body: { label: "x", admin: true } })).status).toBe(422);

    // Nobody else can revoke it.
    const other = await t.login("other-keeper");
    expect((await t.call("revokeApiKey", { token: other, path: { key_id: id } })).status).toBe(404);
    expect((await t.call("revokeApiKey", { token: session, path: { key_id: id } })).status).toBe(204);
    expect((await t.call("getMe", { token: key })).status).toBe(401);
    const after = await t.call<{ items: ApiKey[] }>("listApiKeys", { token: session });
    expect(after.body.items[0]!.revoked_at).not.toBeNull();
    expect((await t.call("revokeApiKey", { token: session, path: { key_id: "key_nope" } })).status).toBe(404);
  });
});

describe("roles", () => {
  it("admin endpoints: 401 without credentials, 403 for non-admins, 200 for admins", async () => {
    const admin = await t.login("founder");
    const donor = await t.login("plain");
    for (const op of ["adminListUsers", "adminListProjects", "adminGetInstance"] as const) {
      expect((await t.call(op)).status).toBe(401);
      const denied = await t.call(op, { token: donor });
      expect(denied.status).toBe(403);
      expect(denied.code).toBe("forbidden");
      expect((await t.call(op, { token: admin })).status).toBe(200);
    }
    const key = await t.apiKey(admin);
    expect((await t.call("adminGetInstance", { token: key })).status).toBe(401);
    expect((await t.call("adminUpdateInstance", { token: donor, body: { name: "pwned" } })).status).toBe(403);
    expect((await t.call("adminUpdateInstance", { token: admin, body: { lease_seconds: 5 } })).status).toBe(422);
    const cfg = await t.call<Schemas["InstanceConfig"]>("adminUpdateInstance", { token: admin, body: { name: "Renamed", description: "d", lease_seconds: 600 } });
    expect(cfg.body).toMatchObject({ name: "Renamed", lease_seconds: 600, project_creation: "open" });
    const meta = (await t.call<Schemas["Meta"]>("getMeta")).body;
    expect(meta).toMatchObject({ name: "Renamed", defaults: { lease_seconds: 600, heartbeat_interval_seconds: 60 } });
    await t.call("adminUpdateInstance", { token: admin, body: { lease_seconds: 7200 } });

    const users = await t.call<{ items: Me[]; next_cursor: string | null }>("adminListUsers", { token: admin, query: { q: "plai" } });
    expect(users.body.items.map((u) => u.handle)).toEqual(["plain"]);
    const page = await t.call<{ items: Me[]; next_cursor: string | null }>("adminListUsers", { token: admin, query: { limit: 2 } });
    expect(page.body.items).toHaveLength(2);
    expect(page.body.next_cursor).not.toBeNull();
  });

  it("an admin can promote, demote and ban; a banned user gets 403 banned everywhere", async () => {
    const admin = await t.login("founder");
    const victim = await t.donor("trouble");
    const up = await t.call<Me>("adminUpdateUser", { token: admin, path: { handle: "trouble" }, body: { role: "maintainer" } });
    expect(up.body.role).toBe("maintainer");
    expect((await t.call("adminUpdateUser", { token: admin, path: { handle: "trouble" }, body: { role: "emperor" } })).status).toBe(422);
    expect((await t.call("adminUpdateUser", { token: admin, path: { handle: "nobody-here" }, body: { banned: true } })).status).toBe(404);
    expect((await t.call("adminUpdateUser", { token: admin, path: { handle: "founder" }, body: { banned: true } })).status).toBe(422);
    expect((await t.call("adminUpdateUser", { token: admin, path: { handle: "founder" }, body: { role: "donor" } })).status).toBe(422);

    const banned = await t.call<Me>("adminUpdateUser", { token: admin, path: { handle: "trouble" }, body: { banned: true } });
    expect(banned.body.banned).toBe(true);
    // Existing sessions are revoked, API keys answer 403 banned, new logins are refused.
    expect((await t.call("getMe", { token: victim.session })).status).toBe(401);
    const viaKey = await t.call("getMe", { token: victim.key });
    expect(viaKey.status).toBe(403);
    expect(viaKey.code).toBe("banned");
    expect((await t.call("listMyClaims", { token: victim.key })).code).toBe("banned");
    const relogin = await t.call("authDev", { body: { handle: "trouble" } });
    expect(relogin.status).toBe(403);
    expect(relogin.code).toBe("banned");
    // Public reads still work with a banned credential attached (treated as anonymous).
    expect((await t.call("getStats", { token: victim.key })).status).toBe(200);
    expect((await t.call("getDonor", { path: { handle: "trouble" } })).status).toBe(404);

    await t.call("adminUpdateUser", { token: admin, path: { handle: "trouble" }, body: { banned: false } });
    expect((await t.call("getMe", { token: victim.key })).status).toBe(200);
  });

  it("project maintenance is for the maintainer or an admin; approval mode keeps new projects pending", async () => {
    const admin = await t.login("founder");
    const { maintainer } = await setupProject(t, "owned", [{ id: "0001-a" }]);
    expect((await t.call<Me>("getMe", { token: maintainer })).body.role).toBe("maintainer");
    const stranger = await t.login("passerby");
    expect((await t.call("updateProject", { token: stranger, path: { slug: "owned" }, body: { token_goal: 1 } })).status).toBe(403);
    expect((await t.call("updateProject", { path: { slug: "owned" }, body: { token_goal: 1 } })).status).toBe(401);
    expect((await t.call("updateProject", { token: maintainer, path: { slug: "owned" }, body: { status: "removed" } })).status).toBe(422);
    expect((await t.call("updateProject", { token: maintainer, path: { slug: "no-such" }, body: {} })).status).toBe(404);
    const patched = await t.call<Schemas["Project"]>("updateProject", { token: maintainer, path: { slug: "owned" }, body: { token_goal: 123_456, status: "paused", follow_branch: false } });
    expect(patched.body).toMatchObject({ token_goal: 123_456, status: "paused", follow_branch: false });
    expect((await t.call<Schemas["Project"]>("updateProject", { token: admin, path: { slug: "owned" }, body: { status: "active" } })).body.status).toBe("active");

    await t.call("adminUpdateInstance", { token: admin, body: { project_creation: "approval" } });
    const pending = await setupProject(t, "waiting", [{ id: "0001-a" }]);
    expect(pending.project.status).toBe("pending");
    // Invisible to the public, visible to its maintainer and admins.
    expect((await t.call("getProject", { path: { slug: "waiting" } })).status).toBe(404);
    expect((await t.call("listTasks", { path: { slug: "waiting" } })).status).toBe(404);
    expect((await t.call("getLedger", { path: { slug: "waiting" } })).status).toBe(404);
    expect((await t.call("listProjectEvents", { path: { slug: "waiting" } })).status).toBe(404);
    expect((await t.call("getProject", { token: stranger, path: { slug: "waiting" } })).status).toBe(404);
    expect((await t.call("getProject", { token: pending.maintainer, path: { slug: "waiting" } })).status).toBe(200);
    const slugs = async (query: Record<string, string>, token?: string) => (await t.call<{ items: Schemas["Project"][] }>("listProjects", { query, token })).body.items.map((p) => p.slug);
    expect(await slugs({})).not.toContain("waiting");
    expect(await slugs({ maintainer: "waiting-owner" })).toEqual([]);
    expect(await slugs({ maintainer: "waiting-owner" }, pending.maintainer)).toEqual(["waiting"]);
    expect((await t.call<Schemas["EventPage"]>("listEvents", { query: { limit: 100 } })).body.items.some((e) => e.project === "waiting")).toBe(false);
    // The maintainer cannot approve their own project; an admin can.
    expect((await t.call("updateProject", { token: pending.maintainer, path: { slug: "waiting" }, body: { status: "active" } })).status).toBe(403);
    const all = await t.call<{ items: Schemas["Project"][] }>("adminListProjects", { token: admin });
    expect(all.body.items.map((p) => p.slug)).toContain("waiting");
    const approved = await t.call<Schemas["Project"]>("adminUpdateProject", { token: admin, path: { slug: "waiting" }, body: { status: "active" } });
    expect(approved.body.status).toBe("active");
    expect((await t.call("getProject", { path: { slug: "waiting" } })).status).toBe(200);
    // Removal hides it again and frees the repo for re-registration.
    await t.call("adminUpdateProject", { token: admin, path: { slug: "waiting" }, body: { status: "removed" } });
    expect((await t.call("getProject", { path: { slug: "waiting" } })).status).toBe(404);
    expect((await t.call("adminUpdateProject", { token: admin, path: { slug: "nope" }, body: { status: "active" } })).status).toBe(404);
    expect((await t.call("adminUpdateProject", { token: pending.maintainer, path: { slug: "waiting" }, body: { status: "active" } })).status).toBe(403);
    await t.call("adminUpdateInstance", { token: admin, body: { project_creation: "open" } });
    const re = await t.call<Schemas["Project"]>("createProject", { token: pending.maintainer, body: { repo_url: pending.repo.url, slug: "waiting-2" } });
    expect(re.status).toBe(201);
  });
});

describe("GitHub OAuth", () => {
  const calls: { url: string; body?: string; auth?: string | null }[] = [];
  const fakeGithub: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined, auth: new Headers(init?.headers).get("authorization") });
    if (url === "https://github.com/login/oauth/access_token") {
      const code = (JSON.parse(String(init?.body)) as { code: string }).code;
      return Response.json(code === "good-code" ? { access_token: "gho_secret", token_type: "bearer", scope: "read:user,user:email" } : { error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 583231, login: "Octo-Cat", email: null, avatar_url: "https://avatars.githubusercontent.com/u/583231" });
    if (url === "https://api.github.com/user/emails") return Response.json([{ email: "old@example.com", primary: false, verified: true }, { email: "octo@example.com", primary: true, verified: true }]);
    return new Response("nope", { status: 404 });
  };
  let o: TestApp;
  beforeAll(async () => {
    o = await createTestApp({ fetch: fakeGithub, env: { GITHUB_CLIENT_ID: "Iv1.client", GITHUB_CLIENT_SECRET: "shhh-client-secret", AUTH_DEV_LOGIN: "false", WEB_ORIGINS: "https://ui.example, http://localhost:5173" } });
  });
  afterAll(async () => {
    await o.close();
  });

  const start = (redirect?: string) => o.call("authGithubStart", redirect === undefined ? {} : { query: { redirect } });

  it("start redirects to GitHub with read-only scopes and a state; the redirect allow-list is enforced", async () => {
    const res = await start("https://ui.example/after?x=1");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("Iv1.client");
    expect(to.searchParams.get("scope")).toBe("read:user user:email");
    expect(to.searchParams.get("redirect_uri")).toBe("http://af.test/v1/auth/github/callback");
    expect(to.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.get("location")).not.toContain("shhh");

    for (const ok of [undefined, "/dashboard", "http://af.test/x", "http://localhost:5173/login"]) expect((await start(ok)).status, String(ok)).toBe(302);
    for (const bad of ["https://evil.example/", "https://ui.example.evil.example/", "//evil.example/x", "javascript:alert(1)", "https://user:pw@ui.example/", "http://ui.example/"]) {
      const r = await start(bad);
      expect(r.status, bad).toBe(422);
      expect(r.code).toBe("validation");
    }
  });

  it("callback exchanges the code, creates the user and returns the session in the fragment; state is single-use", async () => {
    const state = new URL((await start("https://ui.example/after?x=1")).headers.get("location")!).searchParams.get("state")!;
    calls.length = 0;
    const res = await o.call("authGithubCallback", { query: { code: "good-code", state } });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname + to.search).toBe("https://ui.example/after?x=1");
    expect(to.hash).toMatch(/^#token=afs_[A-Za-z0-9_-]{43}$/);
    const token = to.hash.slice("#token=".length);
    const me = (await o.call<Me>("getMe", { token })).body;
    expect(me).toMatchObject({ handle: "octo-cat", github_login: "Octo-Cat", email: "octo@example.com", role: "admin", avatar_url: "https://avatars.githubusercontent.com/u/583231" });
    expect(calls.map((c) => c.url)).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user", "https://api.github.com/user/emails"]);
    expect(calls[1]!.auth).toBe("Bearer gho_secret");
    // The GitHub token is not kept anywhere.
    const dump = JSON.stringify([await o.ctx.db.execute(sql`SELECT * FROM users`), await o.ctx.db.execute(sql`SELECT * FROM sessions`), await o.ctx.db.execute(sql`SELECT * FROM oauth_states`)]);
    expect(dump).not.toContain("gho_secret");

    // Replay of the same state fails; so do unknown states, bad codes and missing parameters.
    for (const query of [{ code: "good-code", state }, { code: "good-code", state: "f".repeat(64) }, { state }, { code: "good-code" }, {}] as Record<string, string>[]) {
      const r = await o.call("authGithubCallback", { query });
      expect(r.status).toBe(400);
    }
    const s2 = new URL((await start()).headers.get("location")!).searchParams.get("state")!;
    expect((await o.call("authGithubCallback", { query: { code: "bad-code", state: s2 } })).status).toBe(400);
    // States expire after ten minutes.
    const s3 = new URL((await start()).headers.get("location")!).searchParams.get("state")!;
    o.clock.advance(601);
    expect((await o.call("authGithubCallback", { query: { code: "good-code", state: s3 } })).status).toBe(400);
    // A second login is the same user.
    const s4 = new URL((await start()).headers.get("location")!).searchParams.get("state")!;
    const again = await o.call("authGithubCallback", { query: { code: "good-code", state: s4 } });
    expect(again.headers.get("location")).toMatch(/^http:\/\/af\.test\/#token=afs_/);
    const users = (await o.ctx.db.execute(sql`SELECT count(*)::int AS n FROM users`)) as unknown as { n: number }[];
    expect(users[0]!.n).toBe(1);
  });

  it("start answers 404 when GitHub OAuth is not configured", async () => {
    const r = await t.call("authGithubStart");
    expect(r.status).toBe(404);
    expect((await t.call("authGithubCallback", { query: { code: "x", state: "y" } })).status).toBe(400);
  });
});

describe("CORS and rate limiting", () => {
  const req = (path: string, init: RequestInit) => t.request(path, init);
  it("public GETs are readable from anywhere; bearer calls only from allowed origins", async () => {
    const anon = await req("/v1/meta", { headers: { origin: "https://random.example" } });
    expect(anon.headers.get("access-control-allow-origin")).toBe("*");
    const withToken = await req("/v1/meta", { headers: { origin: "https://random.example", authorization: "Bearer afs_x" } });
    expect(withToken.headers.get("access-control-allow-origin")).toBeNull();
    for (const origin of ["https://ui.example", "http://af.test"]) {
      const trusted = await req("/v1/me", { headers: { origin, authorization: "Bearer afs_x" } });
      expect(trusted.status).toBe(401);
      expect(trusted.headers.get("access-control-allow-origin")).toBe(origin);
      expect(trusted.headers.get("vary")).toContain("Origin");
    }
    const post = await req("/v1/auth/dev", { method: "POST", headers: { origin: "https://random.example", "content-type": "application/json" }, body: JSON.stringify({ handle: "cors" }) });
    expect(post.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = (origin: string) => req("/v1/me/api-keys", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
    const ok = await preflight("https://ui.example");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://ui.example");
    expect(ok.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(ok.headers.get("access-control-allow-methods")).toMatch(/POST/);
    const no = await preflight("https://random.example");
    expect(no.headers.get("access-control-allow-origin")).toBe("*");
    expect(no.headers.get("access-control-allow-methods")).toBe("GET");
    expect(no.headers.get("access-control-allow-headers")).not.toMatch(/Authorization/i);
  });

  it("answers 429 rate-limited with Retry-After once the per-minute budget is spent", async () => {
    const r = await createTestApp({ env: { RATE_LIMIT_PER_MINUTE: "5", AUTH_RATE_LIMIT_PER_MINUTE: "2" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await r.call("getMeta")).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
      const limited = await r.call("getStats");
      expect(limited.code).toBe("rate-limited");
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await r.request("/healthz")).status).toBe(200); // not an API route
    } finally {
      await r.close();
    }
    const a = await createTestApp({ env: { RATE_LIMIT_PER_MINUTE: "100", AUTH_RATE_LIMIT_PER_MINUTE: "2" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await a.call("authDev", { body: { handle: `u${i}` } })).status);
      expect(statuses).toEqual([200, 200, 429, 429]);
      expect((await a.call("getMeta")).status).toBe(200);
    } finally {
      await a.close();
    }
  });
});
