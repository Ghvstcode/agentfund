import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/ci/adapter.js";
import { judgeCheckRuns, parsePrUrl, pollOnce } from "../src/ci/poller.js";
import type { Schemas } from "../src/lib/openapi.js";
import { createTestApp, projectSecret, WEBHOOK_SECRET, type CallResult, type TestApp } from "./helpers/app.js";
import { claim, genericCi, getProject, getTask, reportCompleted, setupProject } from "./helpers/scenario.js";

type Json = Record<string, unknown>;
const fixture = (name: string): Json => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/github", name), "utf8")) as Json;

/** Routes the server's outbound GitHub calls to fixtures. */
const github = { routes: new Map<string, { status?: number; headers?: Record<string, string>; body: unknown }>(), calls: [] as { url: string; auth: string | null }[] };
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  github.calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
  const hit = github.routes.get(url.replace("https://api.github.com", ""));
  if (!hit) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json", ...hit.headers } });
};

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ fetch: fakeFetch, env: { CI_POLL: "true", GITHUB_TOKEN: "ghp_test_token" } });
  const admin = await t.login("root");
  await t.call("adminUpdateInstance", { token: admin, body: { max_active_claims_per_donor: 50 } });
});
afterAll(async () => {
  await t.close();
});

/** Sends a GitHub delivery, signed by default with the secret of the project the payload names. */
async function gh(event: string, payload: Json, opts: { secret?: string | null; signature?: string } = {}): Promise<CallResult<{ matched: boolean }>> {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "x-github-event": event, "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958", "user-agent": "GitHub-Hookshot/044aadd" };
  const fullName = (payload.repository as Json | undefined)?.full_name;
  if (opts.signature !== undefined) headers["x-hub-signature-256"] = opts.signature;
  else if (opts.secret !== null) headers["x-hub-signature-256"] = signBody(opts.secret ?? (await projectSecret(t, `https://github.com/${String(fullName).toLowerCase()}`)), raw);
  return t.call<{ matched: boolean }>("ciWebhook", { raw, headers });
}

/** A project that is "on GitHub": served from a local repo, matched as github.com/<name>. */
async function githubProject(slug: string, repoName: string, manifests = [{ id: "0001-a" }, { id: "0002-b" }]) {
  const s = await setupProject(t, slug, manifests, { ciProvider: "github" });
  await t.ctx.db.execute(sql`UPDATE projects SET repo_key = ${`https://github.com/${repoName.toLowerCase()}`} WHERE slug = ${slug}`);
  return s;
}

async function reported(slug: string, repoName: string, task: string, donor: string, pr: number) {
  const d = await t.donor(donor);
  const c = await claim(t, d.key, `${slug}:${task}`);
  const report = await reportCompleted(t, d.key, c, { pr_url: `https://github.com/${repoName}/pull/${pr}` });
  return { d, c, report };
}

const workflowRun = (repo: string, report: Schemas["Report"], patch: Json = {}): Json => {
  const f = fixture("workflow_run.completed.json");
  return { ...f, workflow_run: { ...(f.workflow_run as Json), head_branch: report.branch, head_sha: report.head_sha, ...patch }, repository: { ...(f.repository as Json), full_name: repo } };
};
const pullRequest = (repo: string, report: Schemas["Report"], number: number, merged: boolean, patch: Json = {}): Json => {
  const f = fixture("pull_request.closed.json");
  const pr = f.pull_request as Json;
  return { ...f, number, pull_request: { ...pr, number, merged, html_url: `https://github.com/${repo}/pull/${number}`, head: { ...(pr.head as Json), ref: report.branch, sha: report.head_sha }, ...patch }, repository: { ...(f.repository as Json), full_name: repo } };
};

describe("webhook signatures", () => {
  it("verifySignature: HMAC-SHA256 over the raw bytes, constant-time, strict format", () => {
    const body = Buffer.from('{"a":1}');
    const good = signBody("s3cret-s3cret-s3cret", body);
    expect(good).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature("s3cret-s3cret-s3cret", body, good)).toBe(true);
    expect(verifySignature("s3cret-s3cret-s3cret", Buffer.from('{"a": 1}'), good)).toBe(false); // re-serialised body
    expect(verifySignature("other-secret", body, good)).toBe(false);
    expect(verifySignature("s3cret-s3cret-s3cret", body, good.slice(7))).toBe(false);
    expect(verifySignature("s3cret-s3cret-s3cret", body, "sha1=abc")).toBe(false);
    expect(verifySignature("s3cret-s3cret-s3cret", body, "sha256=zz")).toBe(false);
    expect(verifySignature("s3cret-s3cret-s3cret", body, "")).toBe(false);
    expect(verifySignature("s3cret-s3cret-s3cret", body, null)).toBe(false);
    // The example from GitHub's "Validating webhook deliveries" documentation.
    expect(signBody("It's a Secret to Everybody", "Hello, World!")).toBe("sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17");
  });

  it("GitHub: the project's secret is accepted; bad, missing, foreign and unknown-project signatures are 401 bad-signature", async () => {
    await githubProject("sigs", "acme/sigs");
    await githubProject("sigs-other", "acme/sigs-other");
    const f = fixture("ping.json");
    const ping = { ...f, repository: { ...(f.repository as Json), full_name: "acme/sigs" } };
    const ok = await gh("ping", ping);
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ matched: false });
    const other = await projectSecret(t, "https://github.com/acme/sigs-other");
    const refused = [
      await gh("ping", ping, { secret: null }),
      await gh("ping", ping, { secret: "not-the-secret-not-the-secret" }),
      await gh("ping", ping, { secret: other }), // another maintainer's secret
      await gh("ping", ping, { secret: WEBHOOK_SECRET }), // operator secret is not configured on this instance
      await gh("ping", ping, { signature: "sha256=" + "0".repeat(64) }),
      await gh("ping", ping, { signature: "garbage" }),
      await gh("ping", { ...f, repository: { full_name: "nobody/unknown" } }, { secret: other }), // no such project
      await gh("ping", { zen: "x", hook_id: 1 }, { secret: other }), // names no repository at all
    ];
    for (const res of refused) {
      expect(res.status).toBe(401);
      expect(res.code).toBe("bad-signature");
    }
    // Unknown project and wrong secret look exactly the same from outside.
    expect(new Set(refused.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it("generic: signature header required and checked; body must be a GenericCiResult", async () => {
    const { repo } = await setupProject(t, "gensig", [{ id: "0001-a" }]);
    const secret = await projectSecret(t, repo.url);
    const post = (body: string, key: string | null) => t.call<{ matched: boolean }>("ciWebhook", { raw: body, headers: key === null ? {} : { "x-agentfund-signature": signBody(key, body) } });
    const raw = JSON.stringify({ provider: "generic", repo_url: repo.url, branch: "b", head_sha: "a".repeat(40), conclusion: "success" });
    expect((await post(raw, null)).code).toBe("bad-signature");
    expect((await post(raw, "wrong-wrong-wrong-wrong")).code).toBe("bad-signature");
    const ok = await post(raw, secret);
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ matched: false });
    // A repo nobody registered: 401, whatever it is signed with.
    const stray = JSON.stringify({ provider: "generic", repo_url: "https://git.example/x/y", branch: "b", head_sha: "a".repeat(40), conclusion: "success" });
    expect((await post(stray, secret)).code).toBe("bad-signature");
    for (const bad of [{ provider: "other", repo_url: repo.url, branch: "b", head_sha: "a".repeat(40), conclusion: "success" }, { provider: "generic", repo_url: repo.url, branch: "b", head_sha: "short", conclusion: "success" }, { provider: "generic", repo_url: repo.url, branch: "b", head_sha: "a".repeat(40), conclusion: "success", extra: 1 }, { provider: "generic", repo_url: repo.url }]) {
      const res = await post(JSON.stringify(bad), secret);
      expect(res.status).toBe(422);
      expect(res.code).toBe("validation");
    }
    // Unparseable bodies name no project, so they cannot be authenticated at all.
    expect((await post("{nope", secret)).code).toBe("bad-signature");
  });

  it("a maintainer's secret signs for their project only", async () => {
    const a = await setupProject(t, "mine", [{ id: "0001-a" }]);
    const b = await setupProject(t, "theirs", [{ id: "0001-a" }]);
    const victim = await t.donor("victim");
    const c = await claim(t, victim.key, "theirs:0001-a");
    const report = await reportCompleted(t, victim.key, c);
    const mine = (await t.call<Schemas["ProjectWebhook"]>("getProjectWebhook", { token: a.maintainer, path: { slug: "mine" } })).body.secret;
    // The maintainer of "mine" forges a green, merged result for "theirs".
    const forged = JSON.stringify({ provider: "generic", repo_url: b.repo.url, branch: report.branch, head_sha: report.head_sha, conclusion: "success", merged: true });
    const res = await t.call("ciWebhook", { raw: forged, headers: { "x-agentfund-signature": signBody(mine, forged) } });
    expect(res.status).toBe(401);
    expect(res.code).toBe("bad-signature");
    expect((await getTask(t, "theirs", "0001-a")).state).toBe("claimed");
    expect((await getProject(t, "theirs")).totals).toMatchObject({ delivered: 0, merged: 0 });
    // The same bytes signed by the right project go through.
    expect((await genericCi(t, b.repo.url, report, { conclusion: "success" })).body.matched).toBe(true);
    expect((await getProject(t, "theirs")).totals.delivered).toBe(100_000);
  });

  it("webhook config is for the maintainer or an admin; rotation kills the old secret at once", async () => {
    const { repo, maintainer } = await setupProject(t, "hooked", [{ id: "0001-a" }]);
    const get = (token?: string) => t.call<Schemas["ProjectWebhook"]>("getProjectWebhook", { token, path: { slug: "hooked" } });
    const cfg = await get(maintainer);
    expect(cfg.status).toBe(200);
    expect(cfg.body).toMatchObject({ url: "http://af.test/v1/webhooks/ci", provider: "generic", content_type: "application/json", events: [], ci_poll: false });
    expect(cfg.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await get(await t.login("root"))).body.secret).toBe(cfg.body.secret); // admin
    const stranger = await t.donor("hook-stranger");
    expect((await get()).status).toBe(401);
    expect((await get(stranger.session)).status).toBe(403);
    expect((await get(stranger.key)).status).toBe(401);
    expect((await get(await t.apiKey(maintainer))).status).toBe(401); // session only
    expect((await t.call("getProjectWebhook", { token: maintainer, path: { slug: "no-such" } })).status).toBe(404);
    expect((await t.call("rotateProjectWebhook", { token: stranger.session, path: { slug: "hooked" } })).status).toBe(403);
    expect((await t.call("rotateProjectWebhook", { path: { slug: "hooked" } })).status).toBe(401);
    expect((await t.call("rotateProjectWebhook", { token: maintainer, path: { slug: "no-such" } })).status).toBe(404);

    // GitHub projects list the events to subscribe to and whether polling makes the hook optional.
    const ghp = await githubProject("hooked-gh", "acme/hooked-gh");
    expect((await t.call<Schemas["ProjectWebhook"]>("getProjectWebhook", { token: ghp.maintainer, path: { slug: "hooked-gh" } })).body).toMatchObject({ provider: "github", events: ["workflow_run", "check_suite", "pull_request", "push"], ci_poll: true });

    const body = JSON.stringify({ provider: "generic", repo_url: repo.url, branch: "b", head_sha: "a".repeat(40), conclusion: "success" });
    const send = (secret: string) => t.call("ciWebhook", { raw: body, headers: { "x-agentfund-signature": signBody(secret, body) } });
    expect((await send(cfg.body.secret)).status).toBe(202);
    const rotated = await t.call<Schemas["ProjectWebhook"]>("rotateProjectWebhook", { token: maintainer, path: { slug: "hooked" } });
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.body.secret).not.toBe(cfg.body.secret);
    expect((await send(cfg.body.secret)).status).toBe(401);
    expect((await send(rotated.body.secret)).status).toBe(202);
    expect((await get(maintainer)).body.secret).toBe(rotated.body.secret);

    // The secret is in no public response and not in the audit log.
    const dump = JSON.stringify([
      (await t.call("getProject", { path: { slug: "hooked" } })).body,
      (await t.call("listProjects", { query: { limit: 100 } })).body,
      (await t.call("listProjectEvents", { path: { slug: "hooked" }, query: { limit: 100 } })).body,
      (await t.call("adminListProjects", { token: await t.login("root"), query: { limit: 100 } })).body,
      (await t.call("getMeta")).body,
    ]);
    expect(dump).not.toContain(rotated.body.secret);
    expect(dump).not.toContain(cfg.body.secret);
    expect(dump).toContain("project.webhook_rotated");
  });

  it("the operator secret works only when WEBHOOK_SECRET is configured, for any project, and is never shown", async () => {
    const op = await createTestApp({ env: { WEBHOOK_SECRET } });
    try {
      const { repo, maintainer } = await setupProject(op, "orgwide", [{ id: "0001-a" }]);
      const d = await op.donor("org-d");
      const c = await claim(op, d.key, "orgwide:0001-a");
      const report = await reportCompleted(op, d.key, c);
      const body = JSON.stringify({ provider: "generic", repo_url: repo.url, branch: report.branch, head_sha: report.head_sha, conclusion: "success" });
      const res = await op.call<{ matched: boolean }>("ciWebhook", { raw: body, headers: { "x-agentfund-signature": signBody(WEBHOOK_SECRET, body) } });
      expect(res.status).toBe(202);
      expect(res.body.matched).toBe(true);
      const cfg = (await op.call<Schemas["ProjectWebhook"]>("getProjectWebhook", { token: maintainer, path: { slug: "orgwide" } })).body;
      expect(cfg.secret).not.toBe(WEBHOOK_SECRET);
      expect(JSON.stringify([cfg, (await op.call("getMeta")).body, (await op.call("adminGetInstance", { token: maintainer })).body])).not.toContain(WEBHOOK_SECRET);
      // With it, a delivery that names no known project is authenticated but matches nothing; bad JSON is a 422.
      const stray = JSON.stringify({ provider: "generic", repo_url: "https://git.example/x/y", branch: "b", head_sha: "a".repeat(40), conclusion: "success" });
      expect((await op.call("ciWebhook", { raw: stray, headers: { "x-agentfund-signature": signBody(WEBHOOK_SECRET, stray) } })).body).toEqual({ matched: false });
      expect((await op.call("ciWebhook", { raw: "{nope", headers: { "x-agentfund-signature": signBody(WEBHOOK_SECRET, "{nope") } })).status).toBe(422);
      const ping = JSON.stringify({ zen: "x", hook_id: 1 });
      expect((await op.call("ciWebhook", { raw: ping, headers: { "x-github-event": "ping", "x-hub-signature-256": signBody(WEBHOOK_SECRET, ping) } })).status).toBe(202);
    } finally {
      await op.close();
    }
    // The very same signature on an instance without WEBHOOK_SECRET: refused (first test above).
  });

  it("a generic result cannot confirm a GitHub project, and vice versa", async () => {
    const { repo } = await githubProject("crossed", "acme/crossed");
    const { report } = await reported("crossed", "acme/crossed", "0001-a", "cross-d", 1);
    const secret = await projectSecret(t, "https://github.com/acme/crossed");
    // Correctly signed with the project's own secret, but through the wrong adapter: accepted, matches nothing.
    const body = JSON.stringify({ provider: "generic", repo_url: "https://github.com/acme/crossed", branch: report.branch, head_sha: report.head_sha, conclusion: "success" });
    expect((await t.call<{ matched: boolean }>("ciWebhook", { raw: body, headers: { "x-agentfund-signature": signBody(secret, body) } })).body).toEqual({ matched: false });
    expect((await genericCi(t, repo.url, report, { conclusion: "success" })).status).toBe(401); // the file URL is not how this project is known
    expect((await getTask(t, "crossed", "0001-a")).state).toBe("claimed");
  });
});

describe("GitHub adapter", () => {
  it("workflow_run completed/success from a fork delivers; pull_request closed+merged merges", async () => {
    await githubProject("widgets", "acme/widgets");
    const { report } = await reported("widgets", "acme/widgets", "0001-a", "wf-d", 7);

    // Not for us: other actions, other branches, other SHAs, other repos.
    expect((await gh("workflow_run", { ...workflowRun("acme/widgets", report), action: "requested" })).body.matched).toBe(false);
    expect((await gh("workflow_run", workflowRun("acme/widgets", report, { head_branch: "main" }))).body.matched).toBe(false);
    expect((await gh("workflow_run", workflowRun("acme/widgets", report, { head_sha: "f".repeat(40) }))).body.matched).toBe(false);
    expect((await gh("workflow_run", workflowRun("someone/else", report), { secret: await projectSecret(t, "https://github.com/acme/widgets") })).status).toBe(401);
    expect((await getTask(t, "widgets", "0001-a")).state).toBe("claimed");

    // repository.full_name is matched case-insensitively (fixture says "Acme/Widgets").
    const res = await gh("workflow_run", workflowRun("Acme/Widgets", report));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ matched: true });
    const task = await getTask(t, "widgets", "0001-a");
    expect(task.state).toBe("delivered");
    expect(task.latest_report?.ci).toMatchObject({ provider: "github", conclusion: "success", run_url: "https://github.com/acme/widgets/actions/runs/30433642" });
    // Redelivery is idempotent.
    await gh("workflow_run", workflowRun("acme/widgets", report));
    expect((await getProject(t, "widgets")).totals).toMatchObject({ delivered: 100_000, merged: 0 });

    // A PR with the same branch name but another URL is somebody else's PR.
    expect((await gh("pull_request", pullRequest("acme/widgets", report, 999, true))).body.matched).toBe(false);
    expect((await gh("pull_request", { ...pullRequest("acme/widgets", report, 7, true), action: "opened" })).body.matched).toBe(false);
    expect((await gh("pull_request", pullRequest("acme/widgets", report, 7, true))).body).toEqual({ matched: true });
    expect((await getTask(t, "widgets", "0001-a")).state).toBe("merged");
    expect((await getProject(t, "widgets")).totals).toMatchObject({ reported: 100_000, delivered: 100_000, merged: 100_000 });
    expect((await getTask(t, "widgets", "0002-b")).claimable).toBe(true);
  });

  it("a failed workflow_run reopens the task; skipped runs decide nothing; a failing run beats a passing one", async () => {
    await githubProject("flaky", "acme/flaky");
    const a = await reported("flaky", "acme/flaky", "0001-a", "flaky-1", 1);
    expect((await gh("workflow_run", workflowRun("acme/flaky", a.report, { id: 1, conclusion: "skipped" }))).body.matched).toBe(true);
    expect((await getTask(t, "flaky", "0001-a")).state).toBe("claimed");
    await gh("workflow_run", workflowRun("acme/flaky", a.report, { id: 2, conclusion: "failure", html_url: "https://github.com/acme/flaky/actions/runs/2" }));
    const task = await getTask(t, "flaky", "0001-a");
    expect(task.state).toBe("open");
    expect(task.latest_report).toMatchObject({ delivery: "ci_failed", ci: { conclusion: "failure", run_url: "https://github.com/acme/flaky/actions/runs/2" } });
    await gh("workflow_run", workflowRun("acme/flaky", a.report, { id: 3, conclusion: "success" }));
    expect((await getProject(t, "flaky")).totals).toMatchObject({ reported: 100_000, delivered: 0 });

    for (const conclusion of ["cancelled", "timed_out", "action_required"]) {
      const b = await reported("flaky", "acme/flaky", "0002-b", `flaky-${conclusion.replace("_", "-")}`, 2);
      await gh("workflow_run", workflowRun("acme/flaky", b.report, { id: 10, conclusion }));
      expect((await getTask(t, "flaky", "0002-b")).state, conclusion).toBe("open");
    }
  });

  it("check_suite completed delivers even when head_branch is null (commit pushed to a fork)", async () => {
    await githubProject("suite", "acme/suite");
    const { report } = await reported("suite", "acme/suite", "0001-a", "suite-d", 3);
    const f = fixture("check_suite.completed.json");
    const payload = { ...f, check_suite: { ...(f.check_suite as Json), head_sha: report.head_sha }, repository: { ...(f.repository as Json), full_name: "acme/suite" } };
    expect((f.check_suite as Json).head_branch).toBeNull();
    expect((await gh("check_suite", { ...payload, action: "requested" })).body.matched).toBe(false);
    expect((await gh("check_suite", payload)).body).toEqual({ matched: true });
    expect((await getTask(t, "suite", "0001-a")).state).toBe("delivered");
  });

  it("pull_request closed without merging reopens the task; merged before CI goes straight to merged", async () => {
    await githubProject("prs", "acme/prs");
    const a = await reported("prs", "acme/prs", "0001-a", "prs-1", 11);
    expect((await gh("pull_request", pullRequest("acme/prs", a.report, 11, false))).body.matched).toBe(true);
    let task = await getTask(t, "prs", "0001-a");
    expect(task.state).toBe("open");
    expect(task.latest_report?.delivery).toBe("closed");

    const b = await reported("prs", "acme/prs", "0001-a", "prs-2", 12);
    // The maintainer pushed a fix-up to the PR before merging: head.sha moved, the PR is still ours.
    expect((await gh("pull_request", pullRequest("acme/prs", b.report, 12, true, { head: { ref: b.report.branch, sha: "e".repeat(40) } }))).body.matched).toBe(true);
    task = await getTask(t, "prs", "0001-a");
    expect(task.state).toBe("merged");
    expect((await getProject(t, "prs")).totals).toMatchObject({ reported: 200_000, delivered: 100_000, merged: 100_000 });
  });

  it("push to the base branch re-indexes; other refs and unknown repos do not match; malformed payloads are 422", async () => {
    const { repo, project } = await githubProject("pushy", "acme/pushy");
    repo.write("src/new.py", "1\n");
    const head = repo.commit("new code");
    const f = fixture("push.json");
    const push = (ref: string, full_name = "acme/pushy") => gh("push", { ...f, ref, after: head, repository: { ...(f.repository as Json), full_name } });
    expect((await push("refs/heads/feature")).body).toEqual({ matched: false });
    expect((await push("refs/tags/v1")).body).toEqual({ matched: false });
    expect((await push("refs/heads/main", "nobody/nothing")).status).toBe(401);
    expect((await getProject(t, "pushy")).pinned_commit).toBe(project.pinned_commit);
    expect((await push("refs/heads/main")).body).toEqual({ matched: true });
    await expect.poll(async () => (await getProject(t, "pushy")).pinned_commit, { timeout: 15_000 }).toBe(head);

    expect((await gh("issues", { action: "opened", repository: { full_name: "acme/pushy" } })).body).toEqual({ matched: false });
    for (const [event, payload] of [["workflow_run", { action: "completed", repository: { full_name: "acme/pushy" } }], ["workflow_run", { action: "completed", workflow_run: { id: 1, head_sha: "nope", conclusion: "success" }, repository: { full_name: "acme/pushy" } }], ["pull_request", { action: "closed", pull_request: { merged: true }, repository: { full_name: "acme/pushy" } }]] as [string, Json][]) {
      const res = await gh(event, payload);
      expect(res.status, event).toBe(422);
      expect(res.code).toBe("validation");
    }
  });
});

describe("poller (ci_poll)", () => {
  it("judgeCheckRuns: all completed runs must pass, none may still be running", () => {
    const run = (status: string, conclusion: string | null) => ({ status, conclusion, html_url: `https://x/${conclusion}` });
    expect(judgeCheckRuns([])).toBeNull();
    expect(judgeCheckRuns([run("completed", "success"), run("in_progress", null)])).toBeNull();
    expect(judgeCheckRuns([run("queued", null)])).toBeNull();
    expect(judgeCheckRuns([run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")])).toEqual({ conclusion: "success", url: "https://x/success" });
    expect(judgeCheckRuns([run("completed", "skipped")])).toBeNull();
    expect(judgeCheckRuns([run("completed", "success"), run("completed", "failure")])).toEqual({ conclusion: "failure", url: "https://x/failure" });
    expect(judgeCheckRuns([run("in_progress", null), run("completed", "timed_out")])?.conclusion).toBe("failure");
    expect(judgeCheckRuns([run("completed", "cancelled")])?.conclusion).toBe("failure");
  });

  it("parsePrUrl accepts only github.com pull request URLs", () => {
    expect(parsePrUrl("https://github.com/Acme/Widgets/pull/42")).toEqual({ repo: "acme/widgets", number: 42 });
    expect(parsePrUrl("https://github.com/acme/widgets/pull/42/files")).toBeNull();
    expect(parsePrUrl("https://evil.example/acme/widgets/pull/42")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/issues/42")).toBeNull();
  });

  it("confirms delivery and merge from the REST API, with the token, for the project repo only", async () => {
    // Own instance: the poller looks at every pending report on the instance.
    const outer = t;
    t = await createTestApp({ fetch: fakeFetch, env: { CI_POLL: "true", GITHUB_TOKEN: "ghp_test_token" } });
    try {
      await t.call("adminUpdateInstance", { token: await t.login("root"), body: { max_active_claims_per_donor: 50 } });
      await pollScenario();
    } finally {
      await t.close();
      t = outer;
    }
  });

  async function pollScenario(): Promise<void> {
    await githubProject("polled", "acme/polled", [{ id: "0001-a" }, { id: "0002-b" }, { id: "0003-c" }, { id: "0004-d" }]);
    const a = await reported("polled", "acme/polled", "0001-a", "poll-a", 21);
    const b = await reported("polled", "acme/polled", "0002-b", "poll-b", 22);
    const c = await reported("polled", "acme/polled", "0003-c", "poll-c", 23);
    // d points at a PR in another repository: never evidence.
    const d = await reported("polled", "attacker/elsewhere", "0004-d", "poll-d", 24);
    const checks = (sha: string) => `/repos/acme/polled/commits/${sha}/check-runs?per_page=100&page=1`;
    const run = (status: string, conclusion: string | null, n = 1) => ({ id: n, head_sha: "x", name: `job-${n}`, status, conclusion, html_url: `https://github.com/acme/polled/actions/runs/1/job/${n}`, check_suite: { id: 9 }, pull_requests: [] });
    const pr = (n: number, report: Schemas["Report"], state: string, merged: boolean, patch: Json = {}) => ({ number: n, state, merged, merged_at: merged ? "2026-01-15T13:00:00Z" : null, html_url: `https://github.com/acme/polled/pull/${n}`, head: { ref: report.branch, sha: report.head_sha, repo: { full_name: "donor/polled" } }, base: { ref: "main", repo: { full_name: "acme/polled" } }, ...patch });

    github.routes.clear();
    github.calls.length = 0;
    // a: still running. b: green. c: red. d: green checks but a foreign PR.
    github.routes.set(checks(a.report.head_sha!), { body: { total_count: 2, check_runs: [run("completed", "success", 1), run("in_progress", null, 2)] } });
    github.routes.set(checks(b.report.head_sha!), { body: { total_count: 2, check_runs: [run("completed", "success", 1), run("completed", "skipped", 2)] } });
    github.routes.set(checks(c.report.head_sha!), { body: { total_count: 2, check_runs: [run("completed", "success", 1), run("completed", "failure", 2)] } });
    github.routes.set(`/repos/acme/polled/pulls/21`, { body: pr(21, a.report, "open", false) });
    github.routes.set(`/repos/acme/polled/pulls/22`, { body: pr(22, b.report, "open", false) });
    github.routes.set(`/repos/attacker/elsewhere/pulls/24`, { body: pr(24, d.report, "closed", true) });

    let out = await pollOnce(t.ctx);
    expect(out.checked).toBe(4);
    expect(github.calls.every((x) => x.url.startsWith("https://api.github.com/repos/acme/polled/"))).toBe(true);
    expect(github.calls.every((x) => x.auth === "Bearer ghp_test_token")).toBe(true);
    const state = async (id: string) => (await getTask(t, "polled", id)).state;
    expect([await state("0001-a"), await state("0002-b"), await state("0003-c"), await state("0004-d")]).toEqual(["claimed", "delivered", "open", "claimed"]);
    const tb = await getTask(t, "polled", "0002-b");
    expect(tb.latest_report?.ci).toMatchObject({ provider: "github", conclusion: "success", run_url: "https://github.com/acme/polled/actions/runs/1/job/1" });
    expect((await getProject(t, "polled")).totals).toMatchObject({ reported: 400_000, delivered: 100_000, merged: 0 });

    // Next tick: a finishes green, b's PR merges, a's PR is a different branch than reported (ignored).
    github.routes.set(checks(a.report.head_sha!), { body: { total_count: 2, check_runs: [run("completed", "success", 1), run("completed", "success", 2)] } });
    github.routes.set(`/repos/acme/polled/pulls/21`, { body: pr(21, a.report, "closed", true, { head: { ref: "some-other-branch", sha: a.report.head_sha } }) });
    github.routes.set(`/repos/acme/polled/pulls/22`, { body: pr(22, b.report, "closed", true) });
    out = await pollOnce(t.ctx);
    expect([await state("0001-a"), await state("0002-b")]).toEqual(["delivered", "merged"]);
    expect((await getProject(t, "polled")).totals).toMatchObject({ delivered: 200_000, merged: 100_000 });

    // Then a's real PR is closed unmerged: reopened, still delivered, never merged.
    github.routes.set(`/repos/acme/polled/pulls/21`, { body: pr(21, a.report, "closed", false) });
    await pollOnce(t.ctx);
    expect(await state("0001-a")).toBe("open");
    expect((await getProject(t, "polled")).totals).toMatchObject({ delivered: 200_000, merged: 100_000 });

    // Polling is idempotent and stops asking about settled reports.
    github.calls.length = 0;
    out = await pollOnce(t.ctx);
    expect(out.checked).toBe(1); // only d is still pending
    const events = (await t.call<Schemas["EventPage"]>("listProjectEvents", { path: { slug: "polled" }, query: { limit: 100 } })).body.items;
    expect(events.filter((e) => e.action === "task.delivered")).toHaveLength(2);
    expect(events.filter((e) => e.action === "task.merged")).toHaveLength(1);
    expect(events.find((e) => e.action === "ci.result")?.payload).toMatchObject({ source: "poll", provider: "github" });
  }

  it("backs off on a rate limit instead of failing", async () => {
    github.routes.clear();
    await githubProject("limited", "acme/limited");
    const a = await reported("limited", "acme/limited", "0001-a", "lim-a", 31);
    github.routes.set(`/repos/acme/limited/commits/${a.report.head_sha}/check-runs?per_page=100&page=1`, { status: 403, headers: { "x-ratelimit-remaining": "0" }, body: { message: "API rate limit exceeded" } });
    await expect(pollOnce(t.ctx)).resolves.toMatchObject({ applied: 0 });
    expect((await getTask(t, "limited", "0001-a")).state).toBe("claimed");
  });

  it("meta advertises the capability", async () => {
    const meta = (await t.call<Schemas["Meta"]>("getMeta")).body;
    expect(meta.capabilities).toMatchObject({ ci_poll: true, ci_providers: ["github", "generic"], sse: true, dev_login: true, github_oauth: false, federation: true });
  });
});
