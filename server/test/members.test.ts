/**
 * Members-only instances (docs/dev/private-repos.md): config refusals, the read-only GitHub App
 * client, the gate over every API operation and page, membership at sign-in, and the write
 * check that keeps preview from reading private repositories.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { authEnv, parseRepoUrl } from "../src/lib/git.js";
import { GithubApp } from "../src/lib/github-app.js";
import type { OperationId, Schemas } from "../src/lib/openapi.js";
import { createSession, upsertUser } from "../src/services/auth.js";
import { OPEN_OPERATIONS } from "../src/services/members.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { TestRepo } from "./helpers/repo.js";
import { claim, reportCompleted } from "./helpers/scenario.js";

const { privateKey: KEY, publicKey: PUB } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const MEMBERS_ENV = {
  INSTANCE_ACCESS: "members",
  ALLOWED_GITHUB_ORGS: "acme",
  GITHUB_APP_ID: "Iv23.app",
  GITHUB_APP_PRIVATE_KEY: KEY,
  GITHUB_CLIENT_ID: "Iv1.client",
  GITHUB_CLIENT_SECRET: "shhh-client-secret",
  AUTH_DEV_LOGIN: "false",
};

/** A stand-in for api.github.com: one org (acme) with members, repo permissions and installations. */
function fakeGithub(state: { members: Set<string>; permissions: Record<string, string>; oauthLogin: string; tokenBodies: unknown[]; calls: string[] }): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    state.calls.push(`${method} ${url}`);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_user", token_type: "bearer" });
    if (url === "https://api.github.com/user") return Response.json({ id: 1000 + state.oauthLogin.length, login: state.oauthLogin, email: "x@example.com", avatar_url: null });
    let m: RegExpExecArray | null;
    if (/^https:\/\/api\.github\.com\/(repos\/acme\/[^/]+|orgs\/acme)\/installation$/.test(url)) return Response.json({ id: 77 });
    if (/^https:\/\/api\.github\.com\/(repos|orgs)\/[^/]+(\/[^/]+)?\/installation$/.test(url)) return new Response("not installed", { status: 404 });
    if (url === "https://api.github.com/app/installations/77/access_tokens" && method === "POST") {
      state.tokenBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ token: `ghs_${state.tokenBodies.length}`, expires_at: new Date(Date.parse("2026-01-15T12:00:00Z") + 3_600_000).toISOString() }, { status: 201 });
    }
    if ((m = /^https:\/\/api\.github\.com\/orgs\/acme\/members\/([^/]+)$/.exec(url))) return new Response(null, { status: state.members.has(m[1]!.toLowerCase()) ? 204 : 404 });
    if ((m = /^https:\/\/api\.github\.com\/repos\/acme\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(url))) {
      return Response.json({ permission: state.permissions[`${m[1]}:${m[2]!.toLowerCase()}`] ?? "none" });
    }
    return new Response("unexpected", { status: 500 });
  };
}

describe("members-only configuration", () => {
  const base = { DATABASE_URL: "postgres://x@localhost/x", ...MEMBERS_ENV };
  it("accepts the full set", () => {
    const c = loadConfig(base);
    expect(c.instanceAccess).toBe("members");
    expect(c.githubApp?.appId).toBe("Iv23.app");
    expect(c.allowedGithubOrgs).toEqual(["acme"]);
  });
  it.each([
    ["a GitHub App on a public instance", { INSTANCE_ACCESS: "public" }, "needs INSTANCE_ACCESS=members"],
    ["members without the app", { GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "" }, "needs GITHUB_APP_ID"],
    ["members without organizations", { ALLOWED_GITHUB_ORGS: "" }, "needs ALLOWED_GITHUB_ORGS"],
    ["members with dev login", { AUTH_DEV_LOGIN: "true" }, "AUTH_DEV_LOGIN must be false"],
    ["members without GitHub OAuth", { GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "", AUTH_DEV_LOGIN: "" }, "needs GitHub OAuth"],
    ["an app id without a key", { GITHUB_APP_PRIVATE_KEY: "" }, "set both or neither"],
  ])("refuses %s", (_name, patch, message) => {
    expect(() => loadConfig({ ...base, ...patch })).toThrow(message);
  });
});

describe("GitHub App client", () => {
  const state = { members: new Set(["alice"]), permissions: { "api:alice": "write" } as Record<string, string>, oauthLogin: "", tokenBodies: [] as unknown[], calls: [] as string[] };
  let now = Date.parse("2026-01-15T12:00:00Z");
  const app = new GithubApp({ appId: "Iv23.app", privateKey: KEY, fetch: fakeGithub(state), now: () => now });

  it("signs an RS256 JWT backdated 60 s, valid under 10 minutes, issued by the app", () => {
    const [head, body, sig] = app.jwt().split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString()) as { iat: number; exp: number; iss: string };
    expect(claims.iss).toBe("Iv23.app");
    expect(claims.iat).toBe(now / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(PUB, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  it("mints a read-only token narrowed to one repository, and caches it until near expiry", async () => {
    expect(await app.repoToken("acme/api")).toBe("ghs_1");
    expect(state.tokenBodies[0]).toEqual({ repositories: ["api"], permissions: { contents: "read", metadata: "read", checks: "read", pull_requests: "read" } });
    expect(await app.repoToken("acme/api")).toBe("ghs_1");
    now += 56 * 60_000;
    expect(await app.repoToken("acme/api")).toBe("ghs_2");
    expect(await app.repoToken("other/repo")).toBeNull();
  });

  it("checks membership (204 only) and repository permission", async () => {
    expect(await app.isMember(["acme"], "Alice")).toBe(true);
    expect(await app.isMember(["acme"], "mallory")).toBe(false);
    expect(await app.isMember(["acme"], "not a login")).toBe(false);
    expect(await app.permissionOf("acme/api", "alice")).toBe("write");
    expect(await app.permissionOf("acme/api", "mallory")).toBe("none");
    expect(await app.permissionOf("other/repo", "alice")).toBe("none");
  });

  it("passes the git token through the environment, scoped to the repository URL", () => {
    const repo = parseRepoUrl("https://github.com/acme/api", { allowFile: false });
    const env = authEnv(repo, "ghs_secret");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/acme/api/.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from("x-access-token:ghs_secret").toString("base64")}`);
  });
});

describe("members-only instance", () => {
  const state = { members: new Set(["alice", "bob"]), permissions: { "secret:alice": "read", "secret:bob": "admin" } as Record<string, string>, oauthLogin: "alice", tokenBodies: [] as unknown[], calls: [] as string[] };
  let t: TestApp;
  let alice: string;
  let outsider: string;
  let slug: string;

  beforeAll(async () => {
    t = await createTestApp({ fetch: fakeGithub(state), env: MEMBERS_ENV });
    const member = await upsertUser(t.ctx, { github: { id: 1, login: "alice", email: null, avatarUrl: null } });
    alice = await createSession(t.ctx, member.id);
    const stranger = await upsertUser(t.ctx, { github: { id: 2, login: "mallory", email: null, avatarUrl: null } });
    outsider = await createSession(t.ctx, stranger.id);
    const repo = TestRepo.create([{ id: "0001-a" }], { name: "Internal Billing" });
    const created = await t.call<Schemas["Project"]>("createProject", { token: alice, body: { repo_url: repo.url } });
    expect(created.status).toBe(201);
    slug = created.body.slug;
  });
  afterAll(async () => {
    await t.close();
  });

  it("answers every operation outside sign-in and webhooks with 401 to anonymous callers", async () => {
    const leaked: string[] = [];
    for (const op of t.ctx.spec.operations.values()) {
      if (OPEN_OPERATIONS.has(op.id)) continue;
      const path = op.path.replace(/\{task_id\}/g, `${slug}:0001-a`).replace(/\{[a-z_]+\}/g, slug);
      const res = await t.request(path, { method: op.method.toUpperCase(), headers: { "content-type": "application/json" }, ...(op.hasBody ? { body: "{}" } : {}) });
      if (res.status !== 401) leaked.push(`${op.id} ${res.status}`);
    }
    expect(leaked).toEqual([]);
  });

  it("keeps sign-in reachable and says it is members-only", async () => {
    const meta = await t.call<Schemas["Meta"]>("getMeta");
    expect(meta.status).toBe(200);
    expect(meta.body.capabilities.members_only).toBe(true);
    expect(meta.body.capabilities.sse).toBe(false);
    expect(meta.body.capabilities.dev_login).toBe(false);
    expect((await t.call("authGithubStart")).status).toBe(302);
  });

  it("lets members in with a session or a worker key, and keeps non-members out", async () => {
    const list = await t.call<{ items: Schemas["Project"][] }>("listProjects", { token: alice });
    expect(list.status).toBe(200);
    expect(list.body.items.map((p) => p.slug)).toEqual([slug]);
    const key = await t.apiKey(alice);
    expect((await t.call("listMyClaims", { token: key })).status).toBe(200);
    const denied = await t.call("listProjects", { token: outsider });
    expect(denied.status).toBe(403);
    expect(denied.code).toBe("forbidden");
  });

  it("runs a worker's whole loop with a member's API key, and refuses a lapsed member's key", async () => {
    const key = await t.apiKey(alice, "laptop");
    expect((await t.call("getProject", { token: key, path: { slug } })).status).toBe(200);
    expect((await t.call("createPledge", { token: key, path: { slug }, body: { token_amount: 100_000 } })).status).toBe(201);
    const c = await claim(t, key, `${slug}:0001-a`);
    expect((await t.call("heartbeatClaim", { token: key, path: { claim_id: c.claim_id }, body: { tokens_in: 10, tokens_out: 5, phase: "agent" } })).status).toBe(200);
    const report = await reportCompleted(t, key, c);
    expect(report.status).toBe("completed");
    // Sessions are not worker keys, even for members.
    expect((await t.call("claimTask", { token: alice, path: { task_id: `${slug}:0001-a` } })).status).toBe(401);

    // Someone who leaves the organization loses their key once the membership cache expires.
    state.members.delete("alice");
    t.clock.advance(16 * 60);
    const lapsed = await t.call("listMyClaims", { token: key });
    expect(lapsed.status).toBe(403);
    state.members.add("alice");
    t.clock.advance(16 * 60);
    expect((await t.call("listMyClaims", { token: key })).status).toBe(200);
  });

  it("serves pages without project data, and turns off the sitemap, feed and cards", async () => {
    for (const path of ["/", `/${slug}`, `/${slug}/tasks/0001-a`, "/no-such-project"]) {
      const res = await t.request(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta name="robots" content="noindex">');
      expect(html).not.toContain("Internal Billing");
      expect(html).not.toContain("feed.atom");
    }
    for (const path of ["/sitemap.xml", "/feed.atom", `/og/${slug}.png`]) expect((await t.request(path)).status, path).toBe(404);
    expect(await (await t.request("/robots.txt")).text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("refuses to preview or register a GitHub repository without write access, before reading it", async () => {
    state.calls.length = 0;
    const preview = await t.call<Schemas["ProjectPreview"]>("previewProject", { token: alice, body: { repo_url: "https://github.com/acme/secret" } });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ ok: false, errors: ["repository not found or you have no write access to it"] });
    const missing = await t.call<Schemas["ProjectPreview"]>("previewProject", { token: alice, body: { repo_url: "https://github.com/acme/does-not-exist" } });
    expect(missing.body).toEqual(preview.body);
    const create = await t.call("createProject", { token: alice, body: { repo_url: "https://github.com/acme/secret" } });
    expect(create.status).toBe(422);
    expect(state.calls.every((c) => c.includes("api.github.com"))).toBe(true);
  });

  it("signs in members through GitHub and refuses everyone else", async () => {
    const signIn = async (): Promise<{ status: number; location: string | null }> => {
      const start = await t.call("authGithubStart");
      const stateParam = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const res = await t.request(`/v1/auth/github/callback?code=good-code&state=${stateParam}`, { redirect: "manual" });
      return { status: res.status, location: res.headers.get("location") };
    };
    state.oauthLogin = "bob";
    const ok = await signIn();
    expect(ok.status).toBe(302);
    expect(ok.location).toMatch(/#token=afs_/);
    state.oauthLogin = "mallory";
    expect((await signIn()).status).toBe(403);
  });

  it("allows only sign-in and webhooks through without a credential", () => {
    expect([...OPEN_OPERATIONS].sort()).toEqual(["authGithubCallback", "authGithubStart", "ciWebhook", "getMeta"] satisfies OperationId[]);
  });
});
