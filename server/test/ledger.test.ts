import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Schemas } from "../src/lib/openapi.js";
import { sweepLeases } from "../src/services/claims.js";
import { indexAll } from "../src/services/indexer.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { claim, completedBody, DIGEST, genericCi, getProject, getTask, reportCompleted, setupProject } from "./helpers/scenario.js";

type Project = Schemas["Project"];
type Ledger = Schemas["Ledger"];

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const three = [{ id: "0001-a" }, { id: "0002-b", depends_on: ["0001-a"] }, { id: "0003-c", depends_on: ["0001-a", "0002-b"] }];

describe("ledger: pledged → reported → delivered → merged", () => {
  it("walks the happy path and keeps the four columns apart", async () => {
    const { repo, project } = await setupProject(t, "happy", three);
    const alice = await t.donor("alice");
    expect(project.totals).toEqual({ pledged: 0, reported: 0, delivered: 0, merged: 0, in_flight: 0 });
    expect(project.tasks).toMatchObject({ open: 3, claimable: 1 });
    expect(project.trust).toEqual({ tier: "new", merged_tasks: 0, max_tokens_per_task: 5_000_000, max_tokens_per_day: 25_000_000 });

    const pledge = await t.call<Schemas["Pledge"]>("createPledge", { token: alice.key, path: { slug: "happy" }, body: { token_amount: 500_000 } });
    expect(pledge.status).toBe(201);
    expect(pledge.body.id).toMatch(/^plg_/);
    expect((await getProject(t, "happy")).totals.pledged).toBe(500_000);

    const c = await claim(t, alice.key, "happy:0001-a");
    expect(c.claim_id).toMatch(/^clm_[a-z0-9]{20}$/);
    expect(c.commit).toBe(repo.head());
    expect(c.content_hash).toBe(c.task.content_hash);
    expect(c.lease_seconds).toBe(7200);
    expect(c.task.state).toBe("claimed");
    expect(c.task.active_claim?.donor?.handle).toBe("alice");

    // In-flight tokens are display-only.
    const hb = await t.call<{ lease_expires_at: string }>("heartbeatClaim", { token: alice.key, path: { claim_id: c.claim_id }, body: { tokens_in: 30_000, tokens_out: 5_000, phase: "agent" } });
    expect(hb.status).toBe(200);
    let p = await getProject(t, "happy");
    expect(p.totals).toMatchObject({ reported: 0, in_flight: 35_000 });

    const report = await reportCompleted(t, alice.key, c);
    expect(report).toMatchObject({ delivery: "pending_ci", flagged_late: false, status: "completed", ci: null });
    p = await getProject(t, "happy");
    expect(p.totals).toMatchObject({ pledged: 500_000, reported: 100_000, delivered: 0, merged: 0, in_flight: 0 });
    expect((await getTask(t, "happy", "0001-a")).state).toBe("claimed"); // awaiting CI
    expect(p.tasks.claimable).toBe(0);

    // CI passes → delivered.
    expect((await genericCi(t, repo.url, report, { conclusion: "success" })).body).toEqual({ matched: true });
    p = await getProject(t, "happy");
    expect(p.totals).toMatchObject({ reported: 100_000, delivered: 100_000, merged: 0 });
    expect(p.velocity_7d).toBe(100_000);
    let task = await getTask(t, "happy", "0001-a");
    expect(task.state).toBe("delivered");
    expect(task.latest_report).toMatchObject({ delivery: "delivered", ci: { provider: "generic", conclusion: "success" } });
    // Dependents stay blocked until the merge.
    expect((await getTask(t, "happy", "0002-b")).blocked_by).toEqual(["0001-a"]);
    expect((await t.call("claimTask", { token: alice.key, path: { task_id: "happy:0002-b" } })).code).toBe("dependencies-unmet");

    // PR merges → merged. The merge is on the branch, but the pin predates it: a claim now would hand
    // the worker a commit without 0001-a's work (the first real-model run did exactly that).
    repo.write("src/a.py", "# 0001-a\n");
    const merged = repo.commit("Merge 0001-a");
    t.clock.advance(1);
    expect((await genericCi(t, repo.url, report, { conclusion: "success", merged: true })).body.matched).toBe(true);
    p = await getProject(t, "happy");
    expect(p.totals).toMatchObject({ pledged: 500_000, reported: 100_000, delivered: 100_000, merged: 100_000 });
    expect(p.tasks).toMatchObject({ merged: 1, open: 2, claimable: 0 });
    expect(p.trust.merged_tasks).toBe(1);
    expect(await getTask(t, "happy", "0002-b")).toMatchObject({ claimable: false, blocked_by: ["0001-a"] });
    expect((await t.call("claimTask", { token: alice.key, path: { task_id: "happy:0002-b" } })).code).toBe("dependencies-unmet");

    // The indexer follows the branch: the gate opens, and the claim starts from the merge.
    t.clock.advance(1);
    await indexAll(t.ctx);
    p = await getProject(t, "happy");
    expect(p.pinned_commit).toBe(merged);
    expect(p.tasks).toMatchObject({ merged: 1, open: 2, claimable: 1 });
    task = await getTask(t, "happy", "0002-b");
    expect(task).toMatchObject({ claimable: true, blocked_by: [] });
    expect((await getTask(t, "happy", "0003-c")).blocked_by).toEqual(["0002-b"]);
    expect((await claim(t, alice.key, "happy:0002-b")).commit).toBe(merged);

    const ledger = (await t.call<Ledger>("getLedger", { path: { slug: "happy" } })).body;
    expect(ledger.totals).toEqual(p.totals);
    expect(ledger.donors).toEqual([expect.objectContaining({ handle: "alice", pledged: 500_000, reported: 100_000, delivered: 100_000, merged: 100_000, tasks_delivered: 1, tasks_merged: 1 })]);
    expect(ledger.entries.map((e) => e.type).sort()).toEqual(["delivery", "merge", "pledge", "report"]);

    const actions = (await t.call<Schemas["EventPage"]>("listProjectEvents", { path: { slug: "happy" }, query: { limit: 100 } })).body.items.map((e) => e.action);
    for (const a of ["project.created", "manifest.added", "pledge.created", "task.claimed", "report.received", "ci.result", "task.delivered", "task.merged"]) expect(actions).toContain(a);
  });

  it("a dependency unlocks once the branch was read after its merge, whichever came first", async () => {
    const { repo } = await setupProject(t, "landing", three);
    const alice = await t.donor("lander");
    const c = await claim(t, alice.key, "landing:0001-a");
    const report = await reportCompleted(t, alice.key, c);
    await genericCi(t, repo.url, report, { conclusion: "success" });

    // The push is indexed before the merge is reported (webhooks race; e2e and `make trial` merge first).
    repo.write("src/a.py", "# 0001-a\n");
    const merged = repo.commit("Merge 0001-a");
    t.clock.advance(1);
    await indexAll(t.ctx);
    expect((await getProject(t, "landing")).pinned_commit).toBe(merged);
    t.clock.advance(1);
    await genericCi(t, repo.url, report, { conclusion: "success", merged: true });
    expect((await getTask(t, "landing", "0002-b")).blocked_by).toEqual(["0001-a"]);
    // The next read finds the same head. It already contains the merge, so the pin need not move.
    t.clock.advance(1);
    await indexAll(t.ctx);
    expect((await getProject(t, "landing")).pinned_commit).toBe(merged);
    expect((await getTask(t, "landing", "0002-b")).claimable).toBe(true);
    expect((await claim(t, alice.key, "landing:0002-b")).commit).toBe(merged);
  });

  it("a dependency stays blocked while the branch cannot be indexed", async () => {
    const { repo } = await setupProject(t, "broken", three);
    const alice = await t.donor("breaker");
    const c = await claim(t, alice.key, "broken:0001-a");
    const report = await reportCompleted(t, alice.key, c);
    repo.write("src/a.py", "# 0001-a\n");
    repo.write("tasks/0002-b.yaml", "tampered: true\n"); // no longer matches the signed lock
    repo.commit("Merge 0001-a, with a broken task set");
    t.clock.advance(1);
    await genericCi(t, repo.url, report, { conclusion: "success", merged: true });
    t.clock.advance(1);
    await indexAll(t.ctx);
    expect((await getProject(t, "broken")).pinned_commit).not.toBe(repo.head());
    expect(await getTask(t, "broken", "0002-b")).toMatchObject({ claimable: false, blocked_by: ["0001-a"] });
  });

  it("a dependency that landed stays landed when a later push cannot be indexed", async () => {
    const { repo } = await setupProject(t, "laterbreak", three);
    const alice = await t.donor("laterbreaker");
    const c = await claim(t, alice.key, "laterbreak:0001-a");
    const report = await reportCompleted(t, alice.key, c);
    repo.write("src/a.py", "# 0001-a\n");
    const merged = repo.commit("Merge 0001-a");
    t.clock.advance(1);
    await genericCi(t, repo.url, report, { conclusion: "success", merged: true });
    t.clock.advance(1);
    await indexAll(t.ctx);
    expect((await getTask(t, "laterbreak", "0002-b")).claimable).toBe(true);
    // An edit that breaks the signed lock: donors keep working from the last good pin.
    repo.write("tasks/0003-c.yaml", "tampered: true\n");
    repo.commit("Unsigned edit");
    t.clock.advance(1);
    await indexAll(t.ctx);
    expect((await getProject(t, "laterbreak")).pinned_commit).toBe(merged);
    expect((await getTask(t, "laterbreak", "0002-b")).claimable).toBe(true);
    expect((await claim(t, alice.key, "laterbreak:0002-b")).commit).toBe(merged);
  });

  it("failed runs are visible as reported-not-delivered and reopen the task", async () => {
    await setupProject(t, "burny", [{ id: "0001-a" }]);
    const bob = await t.donor("bob");
    for (const status of ["failed", "budget_exceeded", "timeout", "verification_failed"] as const) {
      const c = await claim(t, bob.key, "burny:0001-a");
      const r = await t.call<Schemas["Report"]>("reportClaim", { token: bob.key, path: { claim_id: c.claim_id }, body: { status, tokens_in: 9_000, tokens_out: 1_000, cost_estimate: 0.1, log_digest: DIGEST, message: "nope" } });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ delivery: "none", status, branch: null });
      expect((await getTask(t, "burny", "0001-a")).state).toBe("open");
    }
    const p = await getProject(t, "burny");
    expect(p.totals).toMatchObject({ reported: 40_000, delivered: 0, merged: 0 });
    const task = await getTask(t, "burny", "0001-a");
    expect(task.burn).toEqual({ tokens_in: 36_000, tokens_out: 4_000, total: 40_000, runs: 4 });
  });

  it("CI failure reopens the task; the tokens stay reported only", async () => {
    const { repo } = await setupProject(t, "cifail", [{ id: "0001-a" }]);
    const d = await t.donor("carol");
    const c = await claim(t, d.key, "cifail:0001-a");
    const report = await reportCompleted(t, d.key, c);
    expect((await genericCi(t, repo.url, report, { conclusion: "failure" })).body.matched).toBe(true);
    const task = await getTask(t, "cifail", "0001-a");
    expect(task.state).toBe("open");
    expect(task.latest_report).toMatchObject({ delivery: "ci_failed", ci: { conclusion: "failure" } });
    expect((await getProject(t, "cifail")).totals).toMatchObject({ reported: 100_000, delivered: 0 });
    // A later green result for the same run does not resurrect it.
    await genericCi(t, repo.url, report, { conclusion: "success" });
    expect((await getProject(t, "cifail")).totals.delivered).toBe(0);
    // Someone else can take it again.
    await claim(t, (await t.donor("carol2")).key, "cifail:0001-a");
  });

  it("all completed runs must succeed: one failing run among several fails delivery", async () => {
    const { repo } = await setupProject(t, "multi", [{ id: "0001-a" }, { id: "0002-b" }]);
    const d = await t.donor("multi-d");
    // Results that arrive before the report are evaluated when it lands.
    const c1 = await claim(t, d.key, "multi:0001-a");
    const body = completedBody(c1);
    expect((await genericCi(t, repo.url, { branch: body.branch!, head_sha: body.head_sha! }, { conclusion: "success", run_url: "https://ci.example/lint" })).body).toEqual({ matched: false });
    expect((await genericCi(t, repo.url, { branch: body.branch!, head_sha: body.head_sha! }, { conclusion: "failure", run_url: "https://ci.example/test" })).body).toEqual({ matched: false });
    const r1 = await reportCompleted(t, d.key, c1);
    expect(r1.delivery).toBe("ci_failed");
    expect(r1.ci?.run_url).toBe("https://ci.example/test");

    const c2 = await claim(t, d.key, "multi:0002-b");
    const r2 = await reportCompleted(t, d.key, c2);
    await genericCi(t, repo.url, r2, { conclusion: "success", run_url: "https://ci.example/lint" });
    await genericCi(t, repo.url, r2, { conclusion: "success", run_url: "https://ci.example/test" });
    expect((await getTask(t, "multi", "0002-b")).state).toBe("delivered");
    expect((await getProject(t, "multi")).totals).toMatchObject({ reported: 200_000, delivered: 100_000 });
  });

  it("PR closed unmerged: before CI nothing is delivered; after CI the tokens stay delivered, never merged", async () => {
    const { repo } = await setupProject(t, "closed", [{ id: "0001-a" }]);
    const d = await t.donor("dave");
    let c = await claim(t, d.key, "closed:0001-a");
    let report = await reportCompleted(t, d.key, c);
    await genericCi(t, repo.url, report, { conclusion: "cancelled", closed: true });
    expect((await getTask(t, "closed", "0001-a")).state).toBe("open");
    expect((await getProject(t, "closed")).totals).toMatchObject({ reported: 100_000, delivered: 0 });

    c = await claim(t, d.key, "closed:0001-a");
    report = await reportCompleted(t, d.key, c);
    await genericCi(t, repo.url, report, { conclusion: "success" });
    expect((await getTask(t, "closed", "0001-a")).state).toBe("delivered");
    await genericCi(t, repo.url, report, { conclusion: "success", closed: true });
    const task = await getTask(t, "closed", "0001-a");
    expect(task.state).toBe("open");
    expect(task.latest_report?.delivery).toBe("closed");
    expect((await getProject(t, "closed")).totals).toMatchObject({ reported: 200_000, delivered: 100_000, merged: 0 });
    // A merge reported afterwards changes nothing.
    await genericCi(t, repo.url, report, { conclusion: "success", merged: true });
    expect((await getProject(t, "closed")).totals.merged).toBe(0);
  });

  it("a merge seen before any CI result goes straight to merged and counts as delivered", async () => {
    await setupProject(t, "fastmerge2", [{ id: "0001-a" }]);
    const d = await t.donor("erin");
    const c = await claim(t, d.key, "fastmerge2:0001-a");
    const report = await reportCompleted(t, d.key, c);
    // Evidence row of kind `pr` only: insert through the service the adapters use.
    const { recordEvidence } = await import("../src/services/ci.js");
    const found = (await t.ctx.db.execute(sql`SELECT id FROM projects WHERE slug = 'fastmerge2'`)) as unknown as { id: string }[];
    const out = await recordEvidence(t.ctx, Number(found[0]!.id), { provider: "generic", source: "webhook", kind: "pr", runKey: "pr:1", branch: report.branch ?? null, headSha: report.head_sha ?? null, conclusion: "merged", runUrl: null, prUrl: null });
    expect(out.matched).toBe(true);
    expect((await getTask(t, "fastmerge2", "0001-a")).state).toBe("merged");
    expect((await getProject(t, "fastmerge2")).totals).toMatchObject({ reported: 100_000, delivered: 100_000, merged: 100_000 });
  });

  it("one report per claim; completed needs branch, PR, SHA and a zero exit code; branch name is fixed", async () => {
    await setupProject(t, "rules", [{ id: "0001-a" }]);
    const d = await t.donor("frank");
    const other = await t.donor("mallory");
    const c = await claim(t, d.key, "rules:0001-a");
    const good = completedBody(c);
    const post = (body: unknown, key = d.key) => t.call<Schemas["Problem"]>("reportClaim", { token: key, path: { claim_id: c.claim_id }, body });

    for (const bad of [{ branch: null }, { pr_url: null }, { head_sha: null }, { verify_exit_code: 1 }, { verify_exit_code: null }, { branch: "agentfund/0001-a-wrong123" }, { branch: "main" }]) {
      const r = await post({ ...good, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.code).toBe("validation");
      expect(r.body.errors?.length).toBeGreaterThan(0);
    }
    expect((await post({ ...good, log_digest: "xyz" })).status).toBe(422);
    expect((await post({ ...good, extra: true })).status).toBe(422);
    expect((await post(good, other.key)).code).toBe("forbidden");
    expect((await t.call("heartbeatClaim", { token: other.key, path: { claim_id: c.claim_id } })).status).toBe(403);
    expect((await t.call("releaseClaim", { token: other.key, path: { claim_id: c.claim_id } })).status).toBe(403);
    expect((await t.call("reportClaim", { token: d.key, path: { claim_id: "clm_doesnotexist00000000" }, body: good })).status).toBe(404);

    expect((await post(good)).status).toBe(201);
    const again = await post(good);
    expect(again.status).toBe(409);
    expect(again.code).toBe("already-reported");
    expect((await t.call("heartbeatClaim", { token: d.key, path: { claim_id: c.claim_id } })).code).toBe("claim-not-active");
    expect((await t.call("releaseClaim", { token: d.key, path: { claim_id: c.claim_id } })).code).toBe("claim-not-active");
  });

  it("pr_url may be file:// only when ALLOW_FILE_REPOS is on", async () => {
    // On (the test default): the worker's local git host reports file://<repo>#<branch>.
    const { repo } = await setupProject(t, "localpr", [{ id: "0001-a" }]);
    const d = await t.donor("local-pr");
    const c = await claim(t, d.key, "localpr:0001-a");
    const body = completedBody(c);
    const prUrl = `${repo.url}#${body.branch}`;
    expect((await t.call("reportClaim", { token: d.key, path: { claim_id: c.claim_id }, body: { ...body, pr_url: "ftp://x/y" } })).status).toBe(422);
    expect((await t.call("reportClaim", { token: d.key, path: { claim_id: c.claim_id }, body: { ...body, pr_url: "javascript:alert(1)" } })).status).toBe(422);
    const ok = await t.call<Schemas["Report"]>("reportClaim", { token: d.key, path: { claim_id: c.claim_id }, body: { ...body, pr_url: prUrl } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ pr_url: prUrl, delivery: "pending_ci" });
    await genericCi(t, repo.url, ok.body, { conclusion: "success", merged: true });
    expect((await getTask(t, "localpr", "0001-a")).state).toBe("merged");

    // Off: only http(s) PR URLs are accepted. (The project is registered while file repos are
    // still allowed, then the same database is served by an instance with the flag off.)
    const strict = await createTestApp({ env: { DATABASE_URL: t.config.databaseUrl, ALLOW_FILE_REPOS: "false" }, reuseDatabase: true });
    try {
      await setupProject(t, "strictpr", [{ id: "0001-a" }]);
      const c2 = await claim(strict, d.key, "strictpr:0001-a");
      const b2 = completedBody(c2);
      const refused = await strict.call<Schemas["Problem"]>("reportClaim", { token: d.key, path: { claim_id: c2.claim_id }, body: { ...b2, pr_url: `file:///tmp/repo#${b2.branch}` } });
      expect(refused.status).toBe(422);
      expect(refused.body.errors).toEqual([{ path: "/pr_url", message: "must be an http(s) URL" }]);
      expect((await strict.call("reportClaim", { token: d.key, path: { claim_id: c2.claim_id }, body: b2 })).status).toBe(201);
    } finally {
      await strict.close();
    }
  });

  it("release returns the task and records burned tokens as reported only", async () => {
    await setupProject(t, "release", [{ id: "0001-a" }]);
    const d = await t.donor("gina");
    const c1 = await claim(t, d.key, "release:0001-a");
    expect((await t.call("releaseClaim", { token: d.key, path: { claim_id: c1.claim_id } })).status).toBe(204);
    expect((await getProject(t, "release")).totals.reported).toBe(0);
    expect((await getTask(t, "release", "0001-a")).state).toBe("open");

    const c2 = await claim(t, d.key, "release:0001-a");
    await t.call("heartbeatClaim", { token: d.key, path: { claim_id: c2.claim_id }, body: { tokens_in: 1, tokens_out: 1 } });
    expect((await t.call("releaseClaim", { token: d.key, path: { claim_id: c2.claim_id }, body: { reason: "rate limited", tokens_in: 7_000, tokens_out: 500 } })).status).toBe(204);
    const p = await getProject(t, "release");
    expect(p.totals).toEqual({ pledged: 0, reported: 7_500, delivered: 0, merged: 0, in_flight: 0 });
    const task = await getTask(t, "release", "0001-a");
    expect(task).toMatchObject({ state: "open", active_claim: null, burn: { total: 7_500, runs: 1 } });
    // A released claim cannot be reported.
    const r = await t.call("reportClaim", { token: d.key, path: { claim_id: c2.claim_id }, body: completedBody(c2) });
    expect(r.status).toBe(409);
    expect(r.code).toBe("claim-not-active");
    const ledger = (await t.call<Ledger>("getLedger", { path: { slug: "release" } })).body;
    expect(ledger.entries).toEqual([expect.objectContaining({ type: "report", report_status: "released", tokens: 7_500 })]);
    expect(ledger.donors[0]).toMatchObject({ reported: 7_500, delivered: 0 });
  });

  it("the sweeper expires leases by the clock; a late report is flagged and never counted", async () => {
    // Own instance: the sweeper is global and other tests leave live leases behind.
    const outer = t;
    t = await createTestApp();
    try {
      await sweeperScenario();
    } finally {
      await t.close();
      t = outer;
    }
  });

  async function sweeperScenario(): Promise<void> {
    await setupProject(t, "lease", [{ id: "0001-a" }]);
    const d = await t.donor("hank");
    const c = await claim(t, d.key, "lease:0001-a");
    const expiry = new Date(c.lease_expires_at).getTime();
    expect(expiry - t.clock.now().getTime()).toBe(7200_000);

    // A heartbeat pushes the expiry out.
    t.clock.advance(3600);
    const hb = await t.call<{ lease_expires_at: string }>("heartbeatClaim", { token: d.key, path: { claim_id: c.claim_id }, body: { tokens_in: 50, tokens_out: 50 } });
    expect(new Date(hb.body.lease_expires_at).getTime()).toBe(t.clock.now().getTime() + 7200_000);

    t.clock.advance(7199);
    expect(await sweepLeases(t.ctx)).toBe(0);
    expect((await getTask(t, "lease", "0001-a")).state).toBe("claimed");
    t.clock.advance(2);
    expect(await sweepLeases(t.ctx)).toBe(1);
    const task = await getTask(t, "lease", "0001-a");
    expect(task).toMatchObject({ state: "open", active_claim: null });
    expect((await getProject(t, "lease")).totals.in_flight).toBe(0);
    expect((await t.call("heartbeatClaim", { token: d.key, path: { claim_id: c.claim_id } })).code).toBe("claim-not-active");

    // Somebody else picks the task up; the original worker reports late.
    const other = await t.donor("ivy");
    const c2 = await claim(t, other.key, "lease:0001-a");
    const late = await t.call<Schemas["Report"]>("reportClaim", { token: d.key, path: { claim_id: c.claim_id }, body: completedBody(c) });
    expect(late.status).toBe(201);
    expect(late.body).toMatchObject({ flagged_late: true, delivery: "none" });
    const p = await getProject(t, "lease");
    expect(p.totals).toMatchObject({ reported: 0, delivered: 0 });
    expect((await getTask(t, "lease", "0001-a")).active_claim?.donor?.handle).toBe("ivy");
    // CI on the late branch is not evidence for anything.
    expect((await genericCi(t, p.repo_url, late.body, { conclusion: "success", merged: true })).body.matched).toBe(false);
    expect((await getProject(t, "lease")).totals).toMatchObject({ reported: 0, delivered: 0, merged: 0 });
    expect((await t.call("reportClaim", { token: d.key, path: { claim_id: c.claim_id }, body: completedBody(c) })).code).toBe("already-reported");

    const events = (await t.call<Schemas["EventPage"]>("listProjectEvents", { path: { slug: "lease" } })).body.items.map((e) => e.action);
    expect(events).toContain("claim.expired");
    expect(events).toContain("report.late");
    // Listed, not summed.
    const ledger = (await t.call<Ledger>("getLedger", { path: { slug: "lease" } })).body;
    expect(ledger.entries.some((e) => e.type === "report" && e.tokens === 100_000)).toBe(true);
    expect(ledger.totals.reported).toBe(0);
    await t.call("releaseClaim", { token: other.key, path: { claim_id: c2.claim_id } });
  }

  it("a lease that ran out is treated as expired even before the sweeper runs", async () => {
    await setupProject(t, "lazy", [{ id: "0001-a" }]);
    const d = await t.donor("lazy-d");
    const c = await claim(t, d.key, "lazy:0001-a");
    t.clock.advance(7201);
    const r = await t.call<Schemas["Report"]>("reportClaim", { token: d.key, path: { claim_id: c.claim_id }, body: completedBody(c) });
    expect(r.body.flagged_late).toBe(true);
    expect((await getTask(t, "lazy", "0001-a")).state).toBe("open");
  });

  it("per-donor active-claim limit", async () => {
    await setupProject(t, "limit", [{ id: "0001-a" }, { id: "0002-b" }, { id: "0003-c" }, { id: "0004-d" }]);
    const d = await t.donor("judy");
    const held = [];
    for (const id of ["0001-a", "0002-b", "0003-c"]) held.push(await claim(t, d.key, `limit:${id}`));
    const over = await t.call("claimTask", { token: d.key, path: { task_id: "limit:0004-d" } });
    expect(over.status).toBe(409);
    expect(over.code).toBe("claim-limit");
    await t.call("releaseClaim", { token: d.key, path: { claim_id: held[0]!.claim_id } });
    await claim(t, d.key, "limit:0004-d");
    const mine = await t.call<{ items: Schemas["ClaimSummary"][] }>("listMyClaims", { token: d.key, query: { active: true } });
    expect(mine.body.items.map((c) => c.task_id).sort()).toEqual(["limit:0002-b", "limit:0003-c", "limit:0004-d"]);
    const all = await t.call<{ items: Schemas["ClaimSummary"][] }>("listMyClaims", { token: d.session });
    expect(all.body.items).toHaveLength(4);
    expect(all.body.items.find((c) => c.status === "released")).toBeTruthy();
  });

  it("claims are refused on projects that are not active, and on unknown tasks", async () => {
    const { maintainer } = await setupProject(t, "paused", [{ id: "0001-a" }]);
    const d = await t.donor("kim");
    expect((await t.call("updateProject", { token: maintainer, path: { slug: "paused" }, body: { status: "paused" } })).status).toBe(200);
    const r = await t.call("claimTask", { token: d.key, path: { task_id: "paused:0001-a" } });
    expect(r.status).toBe(409);
    expect(r.code).toBe("project-not-active");
    expect((await t.call("createPledge", { token: d.key, path: { slug: "paused" }, body: { token_amount: 5 } })).code).toBe("project-not-active");
    expect((await t.call("claimTask", { token: d.key, path: { task_id: "paused:0009-nope" } })).status).toBe(404);
    expect((await t.call("claimTask", { token: d.key, path: { task_id: "nonexistent:0001-a" } })).status).toBe(404);
    // Sessions cannot claim: the worker protocol needs an API key.
    expect((await t.call("claimTask", { token: d.session, path: { task_id: "paused:0001-a" } })).status).toBe(401);
  });
});

describe("new-project trust caps", () => {
  it("per-task cap, daily cap by UTC day, and the lift once enough tasks merged", async () => {
    const caps = await createTestApp({ start: "2026-03-01T23:00:00Z" });
    try {
      const admin = await caps.login("root");
      const cfg = await caps.call<Schemas["InstanceConfig"]>("adminUpdateInstance", { token: admin, body: { new_project_max_tokens_per_task: 2_000_000, new_project_max_tokens_per_day: 3_000_000, established_after_merged_tasks: 2, max_active_claims_per_donor: 10 } });
      expect(cfg.body).toMatchObject({ new_project_max_tokens_per_task: 2_000_000, established_after_merged_tasks: 2 });
      const { repo } = await setupProject(caps, "capped", [
        { id: "0001-a", max_tokens: 1_500_000 },
        { id: "0002-b", max_tokens: 1_500_000 },
        { id: "0003-c", max_tokens: 1_000_000 },
        { id: "0004-big", max_tokens: 9_000_000 },
        { id: "0005-e", max_tokens: 1_000_000 },
      ]);
      const d = await caps.donor("capper");
      const big = await caps.call("claimTask", { token: d.key, path: { task_id: "capped:0004-big" } });
      expect(big.status).toBe(409);
      expect(big.code).toBe("project-task-cap");

      const c1 = await claim(caps, d.key, "capped:0001-a"); // 1.5M granted
      const c2 = await claim(caps, d.key, "capped:0002-b"); // 3.0M granted → cap reached
      const daily = await caps.call("claimTask", { token: d.key, path: { task_id: "capped:0003-c" } });
      expect(daily.status).toBe(409);
      expect(daily.code).toBe("project-daily-cap");

      // Next UTC day the budget is fresh.
      caps.clock.set("2026-03-02T00:00:01Z");
      const c3 = await claim(caps, d.key, "capped:0003-c");
      await caps.call("releaseClaim", { token: d.key, path: { claim_id: c3.claim_id } });

      // Merge two tasks → established → both caps lift.
      for (const c of [c1, c2]) {
        const report = await reportCompleted(caps, d.key, c);
        await genericCi(caps, repo.url, report, { conclusion: "success", merged: true });
      }
      const p = (await caps.call<Project>("getProject", { path: { slug: "capped" } })).body;
      expect(p.trust).toEqual({ tier: "established", merged_tasks: 2, max_tokens_per_task: null, max_tokens_per_day: null });
      await claim(caps, d.key, "capped:0004-big");
      await claim(caps, d.key, "capped:0003-c");
      await claim(caps, d.key, "capped:0005-e");
    } finally {
      await caps.close();
    }
  });
});

describe("events are append-only", () => {
  it("UPDATE, DELETE and TRUNCATE on events are rejected by the database", async () => {
    await expect(t.ctx.db.execute(sql`UPDATE events SET action = 'x'`)).rejects.toThrow();
    await expect(t.ctx.db.execute(sql`DELETE FROM events`)).rejects.toThrow();
    await expect(t.ctx.db.execute(sql`TRUNCATE events`)).rejects.toThrow();
    const counted = (await t.ctx.db.execute(sql`SELECT count(*)::int AS n FROM events`)) as unknown as { n: number }[];
    expect(counted[0]!.n).toBeGreaterThan(10);
  });
});

describe("donors, stats and discovery", () => {
  it("leaderboard, profile with streak and rank, stats, search, sorting and filters", async () => {
    const d = await createTestApp({ start: "2026-05-10T12:00:00Z" });
    try {
      const a = await setupProject(d, "alpha-grid", [{ id: "0001-a" }, { id: "0002-b" }]);
      const b = await setupProject(d, "beta-tool", [{ id: "0001-a" }]);
      const x = await d.donor("xena");
      const y = await d.donor("yuri");
      await d.call("createPledge", { token: y.session, path: { slug: "beta-tool" }, body: { token_amount: 42 } });

      // xena delivers on three consecutive days in alpha; yuri delivers once, bigger, in beta.
      const day = async (key: string, task: string, repoUrl: string, tokens: number, merged: boolean) => {
        const c = await claim(d, key, task);
        const r = await reportCompleted(d, key, c, { tokens_in: tokens, tokens_out: 0 });
        await genericCi(d, repoUrl, r, { conclusion: "success", merged });
      };
      await day(x.key, "alpha-grid:0001-a", a.repo.url, 10_000, true);
      d.clock.advance(86_400);
      await day(x.key, "alpha-grid:0002-b", a.repo.url, 20_000, false);
      d.clock.advance(86_400);
      await day(y.key, "beta-tool:0001-a", b.repo.url, 500_000, true);

      const board = (await d.call<{ items: Schemas["DonorStanding"][] }>("listDonors")).body.items;
      expect(board.map((s) => [s.handle, s.delivered, s.tasks_delivered, s.tasks_merged])).toEqual([["yuri", 500_000, 1, 1], ["xena", 30_000, 2, 1]]);
      const page1 = await d.call<{ items: Schemas["DonorStanding"][]; next_cursor: string | null }>("listDonors", { query: { limit: 1 } });
      expect(page1.body.items[0]!.handle).toBe("yuri");
      const page2 = await d.call<{ items: Schemas["DonorStanding"][]; next_cursor: string | null }>("listDonors", { query: { limit: 1, cursor: page1.body.next_cursor! } });
      expect(page2.body.items[0]!.handle).toBe("xena");
      expect(page2.body.next_cursor).toBeNull();

      const xena = (await d.call<Schemas["Donor"]>("getDonor", { path: { handle: "xena" } })).body;
      expect(xena).toMatchObject({ delivered: 30_000, merged: 10_000, rank: 2, projects_backed: 1, streak_days: 2 });
      expect(xena.projects).toEqual([{ slug: "alpha-grid", name: "alpha-grid", pledged: 0, delivered: 30_000, merged: 10_000 }]);
      expect(xena.recent.length).toBeGreaterThan(0);
      const yuri = (await d.call<Schemas["Donor"]>("getDonor", { path: { handle: "yuri" } })).body;
      expect(yuri).toMatchObject({ rank: 1, streak_days: 1, pledged: 42 });
      d.clock.advance(2 * 86_400);
      expect((await d.call<Schemas["Donor"]>("getDonor", { path: { handle: "yuri" } })).body.streak_days).toBe(0);
      expect((await d.call("getDonor", { path: { handle: "nobody" } })).status).toBe(404);

      const stats = (await d.call<Schemas["Stats"]>("getStats")).body;
      expect(stats).toMatchObject({ projects: 2, donors: 2, tasks_merged: 2, tasks_delivered: 3, totals: { pledged: 42, reported: 530_000, delivered: 530_000, merged: 510_000, in_flight: 0 } });

      const list = async (query: Record<string, string | number | boolean>) => (await d.call<{ items: Project[]; next_cursor: string | null }>("listProjects", { query })).body.items.map((p) => p.slug);
      expect(await list({})).toEqual(["beta-tool", "alpha-grid"]); // trending: 7-day delivered velocity
      expect(await list({ sort: "delivered" })).toEqual(["beta-tool", "alpha-grid"]);
      expect(await list({ sort: "recent" })).toEqual(["beta-tool", "alpha-grid"]);
      expect(await list({ q: "alpha" })).toEqual(["alpha-grid"]);
      expect(await list({ q: "demo project" })).toHaveLength(2); // description
      expect(await list({ q: "tests" })).toHaveLength(2); // tags
      expect(await list({ q: "zzzz" })).toEqual([]);
      expect(await list({ tag: "demo", language: "Python" })).toHaveLength(2);
      expect(await list({ tag: "nope" })).toEqual([]);
      expect(await list({ needs_donors: true })).toEqual([]);
      expect(await list({ maintainer: "alpha-grid-owner" })).toEqual(["alpha-grid"]);
      expect(await list({ status: "paused" })).toEqual([]);
      // Velocity window: nine days later nothing is trending any more.
      d.clock.advance(9 * 86_400);
      const later = (await d.call<Project>("getProject", { path: { slug: "beta-tool" } })).body;
      expect(later.velocity_7d).toBe(0);
      expect(later.totals.delivered).toBe(500_000);

      // Pagination over projects.
      const p1 = await d.call<{ items: Project[]; next_cursor: string | null }>("listProjects", { query: { limit: 1, sort: "recent" } });
      const p2 = await d.call<{ items: Project[]; next_cursor: string | null }>("listProjects", { query: { limit: 1, sort: "recent", cursor: p1.body.next_cursor! } });
      expect([p1.body.items[0]!.slug, p2.body.items[0]!.slug]).toEqual(["beta-tool", "alpha-grid"]);
      expect((await d.call("listProjects", { query: { cursor: "garbage!" } })).status).toBe(422);
      expect((await d.call("listProjects", { query: { limit: 500 } })).status).toBe(422);
      expect((await d.call("listProjects", { query: { sort: "bogus" } })).status).toBe(422);

      // Ledger entries paginate newest first.
      const l1 = (await d.call<Ledger>("getLedger", { path: { slug: "alpha-grid" }, query: { limit: 2 } })).body;
      expect(l1.entries).toHaveLength(2);
      const l2 = (await d.call<Ledger>("getLedger", { path: { slug: "alpha-grid" }, query: { limit: 50, cursor: l1.next_cursor! } })).body;
      expect(l1.entries.length + l2.entries.length).toBe(5);
      const ats = [...l1.entries, ...l2.entries].map((e) => e.at);
      expect([...ats].sort().reverse()).toEqual(ats);
      // Events paginate too.
      const e1 = (await d.call<Schemas["EventPage"]>("listEvents", { query: { limit: 3 } })).body;
      const e2 = (await d.call<Schemas["EventPage"]>("listEvents", { query: { limit: 100, cursor: e1.next_cursor! } })).body;
      expect(new Set([...e1.items, ...e2.items].map((e) => e.id)).size).toBe(e1.items.length + e2.items.length);
      expect(e1.items[0]!.id).toMatch(/^evt_/);
    } finally {
      await d.close();
    }
  });
});
