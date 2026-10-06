import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/ci/adapter.js";
import { judgeCheckRuns, parsePrUrl, pollOnce } from "../src/ci/poller.js";
import type { Schemas } from "../src/lib/openapi.js";
import { createTestApp, WEBHOOK_SECRET, type CallResult, type TestApp } from "./helpers/app.js";
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

function gh(event: string, payload: Json, opts: { secret?: string | null; signature?: string } = {}): Promise<CallResult<{ matched: boolean }>> {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "x-github-event": event, "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958", "user-agent": "GitHub-Hookshot/044aadd" };
  if (opts.signature !== undefined) headers["x-hub-signature-256"] = opts.signature;
  else if (opts.secret !== null) headers["x-hub-signature-256"] = signBody(opts.secret ?? WEBHOOK_SECRET, raw);
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

  it("GitHub: good signature accepted; bad, missing and wrong-secret rejected with 401 bad-signature", async () => {
    const ping = fixture("ping.json");
    const ok = await gh("ping", ping);
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ matched: false });
    for (const res of [await gh("ping", ping, { secret: null }), await gh("ping", ping, { secret: "not-the-secret-not-the-secret" }), await gh("ping", ping, { signature: "sha256=" + "0".repeat(64) }), await gh("ping", ping, { signature: "garbage" })]) {
      expect(res.status).toBe(401);
      expect(res.code).toBe("bad-signature");
    }
  });

  it("generic: signature header required and checked; body must be a GenericCiResult", async () => {
    const raw = JSON.stringify({ provider: "generic", repo_url: "https://git.example/x/y", branch: "b", head_sha: "a".repeat(40), conclusion: "success" });
    expect((await t.call("ciWebhook", { raw })).code).toBe("bad-signature");
    expect((await t.call("ciWebhook", { raw, headers: { "x-agentfund-signature": signBody("wrong-wrong-wrong-wrong", raw) } })).code).toBe("bad-signature");
    const ok = await t.call("ciWebhook", { raw, headers: { "x-agentfund-signature": signBody(WEBHOOK_SECRET, raw) } });
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ matched: false });
    for (const bad of [{ provider: "generic" }, { provider: "other", repo_url: "x", branch: "b", head_sha: "a".repeat(40), conclusion: "success" }, { provider: "generic", repo_url: "x", branch: "b", head_sha: "short", conclusion: "success" }, { provider: "generic", repo_url: "x", branch: "b", head_sha: "a".repeat(40), conclusion: "success", extra: 1 }]) {
      const body = JSON.stringify(bad);
      const res = await t.call("ciWebhook", { raw: body, headers: { "x-agentfund-signature": signBody(WEBHOOK_SECRET, body) } });
      expect(res.status).toBe(422);
      expect(res.code).toBe("validation");
    }
    const notJson = "{nope";
    expect((await t.call("ciWebhook", { raw: notJson, headers: { "x-agentfund-signature": signBody(WEBHOOK_SECRET, notJson) } })).status).toBe(422);
  });

  it("a generic result cannot confirm a GitHub project, and vice versa", async () => {
    const { repo } = await githubProject("crossed", "acme/crossed");
    const { report } = await reported("crossed", "acme/crossed", "0001-a", "cross-d", 1);
    expect((await genericCi(t, repo.url, report, { conclusion: "success" })).body.matched).toBe(false);
    expect((await genericCi(t, "https://github.com/acme/crossed", report, { conclusion: "success" })).body.matched).toBe(false);
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
    expect((await gh("workflow_run", workflowRun("someone/else", report))).body.matched).toBe(false);
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
    expect((await push("refs/heads/main", "nobody/nothing")).body).toEqual({ matched: false });
    expect((await getProject(t, "pushy")).pinned_commit).toBe(project.pinned_commit);
    expect((await push("refs/heads/main")).body).toEqual({ matched: true });
    await expect.poll(async () => (await getProject(t, "pushy")).pinned_commit, { timeout: 15_000 }).toBe(head);

    expect((await gh("issues", { action: "opened", repository: { full_name: "acme/pushy" } })).body).toEqual({ matched: false });
    for (const [event, payload] of [["workflow_run", { action: "completed", repository: { full_name: "acme/pushy" } }], ["workflow_run", { action: "completed", workflow_run: { id: 1, head_sha: "nope", conclusion: "success" }, repository: { full_name: "acme/pushy" } }], ["pull_request", { action: "closed", pull_request: { merged: true }, repository: { full_name: "acme/pushy" } }], ["push", { ref: "refs/heads/main" }]] as [string, Json][]) {
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
    expect(meta.capabilities).toMatchObject({ ci_poll: true, ci_providers: ["github", "generic"], sse: true, dev_login: true, github_oauth: false, federation: false });
  });
});
