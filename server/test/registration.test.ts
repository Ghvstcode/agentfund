/**
 * Registration on a public instance: the caller must be able to push to the GitHub repository,
 * asked of GitHub with their own sign-in token, which stays sealed on the session.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRepoUrl } from "../src/lib/git.js";
import type { Schemas } from "../src/lib/openapi.js";
import { authenticate, createSession, openGithubToken, upsertUser, type Principal } from "../src/services/auth.js";
import { requirePushAccess } from "../src/services/indexer.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { TestRepo } from "./helpers/repo.js";

const PUBLIC_ENV = { GITHUB_CLIENT_ID: "Iv1.client", GITHUB_CLIENT_SECRET: "shhh-client-secret", AUTH_DEV_LOGIN: "false", ADMIN_HANDLES: "root" };

interface GithubState {
  /** OAuth code → [token, login]. */
  codes: Record<string, [string, string]>;
  /** `token repo` → permissions.push. */
  push: Record<string, boolean>;
  calls: { url: string; auth: string | null }[];
}

/** A stand-in for GitHub: OAuth, the profile, and repositories with per-token permissions. */
function fakeGithub(state: GithubState): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    state.calls.push({ url, auth });
    if (url === "https://github.com/login/oauth/access_token") {
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      const hit = state.codes[code];
      return hit ? Response.json({ access_token: hit[0], token_type: "bearer" }) : Response.json({ error: "bad_verification_code" });
    }
    const token = auth?.replace(/^Bearer /, "") ?? "";
    if (url === "https://api.github.com/user") {
      const i = Object.values(state.codes).findIndex(([t]) => t === token);
      const login = Object.values(state.codes)[i]?.[1];
      return login ? Response.json({ id: 5000 + i, login, email: `${login}@example.com`, avatar_url: null }) : new Response(null, { status: 401 });
    }
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(url);
    if (m) {
      const repo = m[1]!;
      if (token === "gho_revoked") return Response.json({ message: "Bad credentials" }, { status: 401 });
      if (repo === "acme/flaky") return new Response("bad gateway", { status: 502 });
      if (repo === "acme/old-name") return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/1" } });
      if (repo === "acme/missing") return Response.json({ message: "Not Found" }, { status: 404 });
      const push = state.push[`${token} ${repo}`] ?? false;
      return Response.json({ full_name: repo, private: false, permissions: { admin: false, maintain: false, push, triage: push, pull: true } });
    }
    return new Response("unexpected", { status: 500 });
  };
}

async function signIn(t: TestApp, code: string): Promise<string> {
  const start = await t.call("authGithubStart");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const res = await t.request(`/v1/auth/github/callback?code=${code}&state=${state}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  return /#token=(afs_[A-Za-z0-9_-]+)/.exec(res.headers.get("location")!)![1]!;
}

const principal = async (t: TestApp, token: string): Promise<Principal> => (await authenticate(t.ctx, token))!;

describe("registering on a public instance", () => {
  const state: GithubState = {
    codes: { "code-alice": ["gho_alice", "alice"], "code-bob": ["gho_bob", "bob"], "code-root": ["gho_root", "root"], "code-gone": ["gho_revoked", "gone"] },
    push: { "gho_alice acme/tool": true },
    calls: [],
  };
  let t: TestApp;
  let alice: string;
  let bob: string;
  let root: string;

  beforeAll(async () => {
    t = await createTestApp({ fetch: fakeGithub(state), env: PUBLIC_ENV });
    expect(t.config.authDevLogin).toBe(false);
    root = await signIn(t, "code-root");
    alice = await signIn(t, "code-alice");
    bob = await signIn(t, "code-bob");
  });
  afterAll(async () => {
    await t.close();
  });

  it("keeps the GitHub sign-in token on the session, sealed under the session token", async () => {
    const [row] = (await t.ctx.db.execute(sql`SELECT s.github_token_sealed FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.handle = 'alice'`)) as unknown as { github_token_sealed: string }[];
    expect(row!.github_token_sealed).toBeTruthy();
    expect(row!.github_token_sealed).not.toContain("gho_alice");
    expect(openGithubToken(alice, row!.github_token_sealed)).toBe("gho_alice");
    expect(openGithubToken(bob, row!.github_token_sealed)).toBeNull();
    expect((await principal(t, alice)).githubToken?.()).toBe("gho_alice");
  });

  it("refuses preview and create without push access, asking GitHub with the caller's own token", async () => {
    state.calls.length = 0;
    const preview = await t.call<Schemas["Problem"]>("previewProject", { token: bob, body: { repo_url: "https://github.com/acme/tool" } });
    expect(preview.status).toBe(403);
    expect(preview.code).toBe("forbidden");
    expect(preview.body.detail).toContain("push access to acme/tool");
    const create = await t.call("createProject", { token: bob, body: { repo_url: "https://github.com/acme/tool" } });
    expect(create.status).toBe(403);
    expect(create.code).toBe("forbidden");
    // Only GitHub's API was asked, with bob's token; nothing was cloned or created.
    expect(state.calls).toEqual([
      { url: "https://api.github.com/repos/acme/tool", auth: "Bearer gho_bob" },
      { url: "https://api.github.com/repos/acme/tool", auth: "Bearer gho_bob" },
    ]);
    expect((await t.ctx.db.execute(sql`SELECT id FROM projects`)).length).toBe(0);
  });

  it("lets someone with push access through", async () => {
    await expect(requirePushAccess(t.ctx, await principal(t, alice), parseRepoUrl("https://github.com/acme/tool", { allowFile: false }))).resolves.toBeUndefined();
    await expect(requirePushAccess(t.ctx, await principal(t, alice), parseRepoUrl("https://github.com/acme/other", { allowFile: false }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it.each([
    ["a repository GitHub does not show", "https://github.com/acme/missing", "check the URL"],
    ["a renamed repository", "https://github.com/acme/old-name", "current URL"],
    ["a GitHub outage", "https://github.com/acme/flaky", "try again"],
    ["a repository off github.com", "https://gitlab.com/acme/tool", "ask an admin"],
  ])("fails closed on %s", async (_name, repo_url, message) => {
    const r = await t.call<Schemas["Problem"]>("previewProject", { token: alice, body: { repo_url } });
    expect(r.status).toBe(403);
    expect(r.body.detail).toContain(message);
  });

  it("asks a session without a usable GitHub token to sign in again", async () => {
    const user = await upsertUser(t.ctx, { github: { id: 5001, login: "bob", email: null, avatarUrl: null } });
    const old = await createSession(t.ctx, user.id); // as sessions from before the token was kept
    const r = await t.call<Schemas["Problem"]>("createProject", { token: old, body: { repo_url: "https://github.com/acme/tool" } });
    expect(r.status).toBe(403);
    expect(r.body.detail).toContain("sign in with GitHub again");
    const gone = await signIn(t, "code-gone");
    const revoked = await t.call<Schemas["Problem"]>("previewProject", { token: gone, body: { repo_url: "https://github.com/acme/tool" } });
    expect(revoked.status).toBe(403);
    expect(revoked.body.detail).toContain("sign in with GitHub again");
  });

  it("lets an admin register any repository, without asking GitHub", async () => {
    state.calls.length = 0;
    await expect(requirePushAccess(t.ctx, await principal(t, root), parseRepoUrl("https://github.com/acme/missing", { allowFile: false }))).resolves.toBeUndefined();
    await expect(requirePushAccess(t.ctx, await principal(t, root), parseRepoUrl("https://gitlab.com/acme/tool", { allowFile: false }))).resolves.toBeUndefined();
    expect(state.calls).toEqual([]);
    const repo = TestRepo.create([{ id: "0001-a" }], { name: "Admin Registered" });
    expect((await t.call("createProject", { token: root, body: { repo_url: repo.url } })).status).toBe(201);
  });
});

describe("registering with dev login", () => {
  let t: TestApp;
  const calls: string[] = [];
  beforeAll(async () => {
    t = await createTestApp({ fetch: async (input) => (calls.push(String(input)), new Response("unexpected", { status: 500 })) });
  });
  afterAll(async () => {
    await t.close();
  });

  it("skips the GitHub check for dev-login users, who have no GitHub to ask", async () => {
    expect(t.config.authDevLogin).toBe(true);
    await t.login("first-admin");
    const dev = await principal(t, await t.login("dev-maintainer"));
    expect(dev.user.role).not.toBe("admin");
    await expect(requirePushAccess(t.ctx, dev, parseRepoUrl("https://github.com/acme/tool", { allowFile: false }))).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
