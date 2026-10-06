/**
 * CI and PR evidence → ledger transitions (protocol.md §4, §6, §7).
 * Adapters (GitHub webhook, generic webhook, poller) only translate their input into
 * `Evidence`; everything that changes state lives here, in one transaction per piece of evidence.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { iso, one, rows, tsParam, type Tx } from "../db/client.js";
import { manifests, reports } from "../db/schema.js";
import { appendEvent } from "./events.js";

export interface Evidence {
  provider: "github" | "generic";
  source: "webhook" | "poll";
  /** `ci` = a finished CI run; `pr` = the pull request reached a final state. */
  kind: "ci" | "pr";
  /** Stable identity of the run / PR within the project; re-deliveries and re-runs replace the earlier row. */
  runKey: string;
  branch: string | null;
  headSha: string | null;
  /** ci: provider conclusion (`success`, `failure`, …). pr: `merged` or `closed`. */
  conclusion: string;
  runUrl: string | null;
  prUrl: string | null;
}

/** Conclusions that are neither a pass nor a failure and are recorded but never decide anything. */
const NON_RESULTS = new Set(["skipped", "neutral", "stale"]);

const lower = (s: string | null): string | null => (s === null ? null : s.toLowerCase());

/**
 * Stores a piece of evidence for a project and applies it to every report it matches.
 * `matched` is false when no report corresponds; the row is still kept so that a report
 * arriving after its CI result is evaluated against it.
 */
export async function recordEvidence(ctx: AppContext, projectId: number, ev: Evidence): Promise<{ matched: boolean }> {
  const now = ctx.clock.now();
  return ctx.db.transaction(async (tx) => {
    const match =
      ev.kind === "ci"
        ? sql`r.head_sha = ${ev.headSha} AND (${ev.branch}::text IS NULL OR r.branch = ${ev.branch})`
        : ev.prUrl
          ? sql`r.branch = ${ev.branch} AND lower(r.pr_url) = ${lower(ev.prUrl)}`
          : sql`r.branch = ${ev.branch} AND r.head_sha = ${ev.headSha}`;
    const hits = await rows<{ id: string; public_id: string; slug: string; mid: string }>(
      tx,
      sql`SELECT r.id, r.public_id, p.slug, m.manifest_id AS mid
          FROM reports r JOIN projects p ON p.id = r.project_id JOIN manifests m ON m.id = r.manifest_id
          WHERE r.project_id = ${projectId} AND r.status = 'completed' AND NOT r.flagged_late AND ${match}
          ORDER BY r.id`,
    );
    const first = hits[0];
    const prior = await one<{ conclusion: string; head_sha: string | null; report_id: string | null }>(
      tx,
      sql`SELECT conclusion, head_sha, report_id FROM ci_results WHERE project_id = ${projectId} AND run_key = ${ev.runKey} FOR UPDATE`,
    );
    // New information = a new run, a new outcome for a re-run, or the first time it matches a report.
    const news = !prior || prior.conclusion !== ev.conclusion || prior.head_sha !== ev.headSha || (prior.report_id === null && first !== undefined);
    await tx.execute(
      sql`INSERT INTO ci_results (project_id, report_id, provider, source, kind, run_key, branch, head_sha, conclusion, run_url, pr_url, received_at)
          VALUES (${projectId}, ${first ? Number(first.id) : null}, ${ev.provider}, ${ev.source}, ${ev.kind}, ${ev.runKey}, ${ev.branch}, ${ev.headSha},
                  ${ev.conclusion}, ${ev.runUrl}, ${ev.prUrl}, ${tsParam(now)})
          ON CONFLICT (project_id, run_key) DO UPDATE
            SET conclusion = EXCLUDED.conclusion, run_url = EXCLUDED.run_url, branch = EXCLUDED.branch, head_sha = EXCLUDED.head_sha,
                pr_url = EXCLUDED.pr_url, source = EXCLUDED.source, report_id = coalesce(EXCLUDED.report_id, ci_results.report_id),
                received_at = CASE WHEN ${news} THEN EXCLUDED.received_at ELSE ci_results.received_at END`,
    );
    for (const h of hits) {
      if (news && ev.kind === "ci") {
        await appendEvent(ctx, tx, {
          actor: "ci",
          action: "ci.result",
          projectId,
          project: h.slug,
          taskId: `${h.slug}:${h.mid}`,
          payload: { report_id: h.public_id, provider: ev.provider, source: ev.source, conclusion: ev.conclusion, run_url: ev.runUrl, head_sha: ev.headSha },
        });
      }
      await evaluateReport(ctx, tx, Number(h.id));
    }
    return { matched: hits.length > 0 };
  });
}

interface EvidenceRow {
  kind: "ci" | "pr";
  provider: string;
  conclusion: string;
  run_url: string | null;
  received_at: string;
}

/**
 * Re-derives a completed report's place in the ledger from all evidence on file.
 * Idempotent; only ever moves forward: pending_ci → delivered | ci_failed | merged | closed,
 * delivered → merged | closed.
 */
export async function evaluateReport(ctx: AppContext, tx: Tx, reportId: number): Promise<boolean> {
  const [r] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("no key update");
  if (!r || r.status !== "completed" || r.flaggedLate) return false;
  if (r.delivery !== "pending_ci" && r.delivery !== "delivered") return false;

  const evidence = await rows<EvidenceRow>(
    tx,
    sql`SELECT kind, provider, conclusion, run_url, received_at FROM ci_results
        WHERE project_id = ${r.projectId} AND (
          (kind = 'ci' AND head_sha = ${r.headSha} AND (branch IS NULL OR branch = ${r.branch}))
          OR (kind = 'pr' AND branch = ${r.branch} AND ((pr_url IS NOT NULL AND lower(pr_url) = ${lower(r.prUrl)}) OR (pr_url IS NULL AND head_sha = ${r.headSha})))
        ) ORDER BY received_at, id`,
  );
  const ci = evidence.filter((e) => e.kind === "ci" && !NON_RESULTS.has(e.conclusion));
  const merged = evidence.some((e) => e.kind === "pr" && e.conclusion === "merged");
  const closed = !merged && evidence.some((e) => e.kind === "pr" && e.conclusion === "closed");
  const failure = ci.find((e) => e.conclusion !== "success");
  // "All completed runs for the head SHA succeeded."
  const passed = ci.length > 0 && !failure;
  const deciding = failure ?? ci[ci.length - 1];

  const ref = await one<{ slug: string; mid: string; handle: string }>(
    tx,
    sql`SELECT p.slug, m.manifest_id AS mid, u.handle FROM manifests m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = ${r.userId} WHERE m.id = ${r.manifestId}`,
  );
  if (!ref) return false;
  const now = ctx.clock.now();
  const taskRef = `${ref.slug}:${ref.mid}`;
  const tokens = r.tokensIn + r.tokensOut;
  const base = { projectId: r.projectId, project: ref.slug, taskId: taskRef };
  const ciFields = deciding ? { ciProvider: deciding.provider, ciConclusion: deciding.conclusion, ciRunUrl: deciding.run_url, ciReceivedAt: new Date(iso(deciding.received_at)) } : {};
  const moveTask = async (from: ("claimed" | "delivered")[], to: "open" | "delivered" | "merged"): Promise<boolean> => {
    const moved = await tx.update(manifests).set({ state: to, updatedAt: now }).where(and(eq(manifests.id, r.manifestId), inArray(manifests.state, from))).returning({ id: manifests.id });
    return moved.length > 0;
  };

  if (merged) {
    const viaMerge = r.delivery === "pending_ci";
    await tx.update(reports).set({ delivery: "merged", deliveredAt: r.deliveredAt ?? now, mergedAt: now, ...(viaMerge ? ciFields : {}) }).where(eq(reports.id, r.id));
    await moveTask(["claimed", "delivered"], "merged");
    if (viaMerge) await appendEvent(ctx, tx, { actor: "ci", action: "task.delivered", ...base, payload: { report_id: r.publicId, donor: ref.handle, tokens, via: "merge", pr_url: r.prUrl } });
    await appendEvent(ctx, tx, { actor: "ci", action: "task.merged", ...base, payload: { report_id: r.publicId, donor: ref.handle, tokens, pr_url: r.prUrl } });
    return true;
  }
  if (closed) {
    await tx.update(reports).set({ delivery: "closed", closedAt: now }).where(eq(reports.id, r.id));
    if (await moveTask(["claimed", "delivered"], "open")) {
      await appendEvent(ctx, tx, { actor: "ci", action: "task.reopened", ...base, payload: { reason: "pr_closed", report_id: r.publicId, pr_url: r.prUrl } });
    }
    return true;
  }
  if (r.delivery !== "pending_ci") return false;
  if (failure) {
    await tx.update(reports).set({ delivery: "ci_failed", ...ciFields }).where(eq(reports.id, r.id));
    if (await moveTask(["claimed"], "open")) {
      await appendEvent(ctx, tx, { actor: "ci", action: "task.reopened", ...base, payload: { reason: "ci_failed", report_id: r.publicId, conclusion: failure.conclusion, run_url: failure.run_url } });
    }
    return true;
  }
  if (passed) {
    await tx.update(reports).set({ delivery: "delivered", deliveredAt: now, ...ciFields }).where(eq(reports.id, r.id));
    await moveTask(["claimed"], "delivered");
    await appendEvent(ctx, tx, { actor: "ci", action: "task.delivered", ...base, payload: { report_id: r.publicId, donor: ref.handle, tokens, pr_url: r.prUrl, run_url: deciding?.run_url ?? null } });
    return true;
  }
  return false;
}

/** Projects that CI evidence for `repoKey` may apply to. */
export async function projectsForRepo(ctx: AppContext, repoKey: string): Promise<{ id: number; slug: string; ciProvider: string; baseBranch: string }[]> {
  const list = await rows<{ id: string; slug: string; ci_provider: string; base_branch: string }>(
    ctx.db,
    sql`SELECT id, slug, ci_provider, base_branch FROM projects WHERE repo_key = ${repoKey} AND status <> 'removed'`,
  );
  return list.map((p) => ({ id: Number(p.id), slug: p.slug, ciProvider: p.ci_provider, baseBranch: p.base_branch }));
}
