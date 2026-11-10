/**
 * The ledger is never stored: every number here is computed from evidence rows
 * (pledges, reports, burns, CI/merge timestamps, live claims). See protocol.md §6.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { iso, num, one, rows, tsParam, type Queryable } from "../db/client.js";
import { decodeCursor, encodeCursor, offsetOf, pageByOffset } from "../lib/cursor.js";
import type { Schemas } from "../lib/openapi.js";
import { Problem, validation } from "../lib/problem.js";
import { toUserRef } from "./auth.js";

type Totals = Schemas["Totals"];
type TaskCounts = Schemas["TaskCounts"];

/** Projects whose numbers are public: everything except removed and not-yet-approved ones. */
const LISTED = sql`status IN ('active', 'paused')`;

interface TotalsRow {
  pledged: string;
  reported: string;
  delivered: string;
  merged: string;
  in_flight: string;
}
const toTotals = (r: TotalsRow | undefined): Totals => ({
  pledged: num(r?.pledged),
  reported: num(r?.reported),
  delivered: num(r?.delivered),
  merged: num(r?.merged),
  in_flight: num(r?.in_flight),
});

/** Totals for one project, or instance-wide over listed projects when `projectId` is omitted. */
export async function totals(q: Queryable, projectId?: number): Promise<Totals> {
  const scope = (col: SQL): SQL => (projectId !== undefined ? sql`${col} = ${projectId}` : sql`${col} IN (SELECT id FROM projects WHERE ${LISTED})`);
  const r = await one<TotalsRow>(
    q,
    sql`SELECT
      (SELECT coalesce(sum(token_amount), 0) FROM pledges WHERE ${scope(sql`project_id`)})::text AS pledged,
      ((SELECT coalesce(sum(tokens_in + tokens_out), 0) FROM reports WHERE NOT flagged_late AND ${scope(sql`project_id`)})
        + (SELECT coalesce(sum(tokens_in + tokens_out), 0) FROM burns WHERE ${scope(sql`project_id`)}))::text AS reported,
      (SELECT coalesce(sum(tokens_in + tokens_out), 0) FROM reports WHERE delivered_at IS NOT NULL AND ${scope(sql`project_id`)})::text AS delivered,
      (SELECT coalesce(sum(tokens_in + tokens_out), 0) FROM reports WHERE merged_at IS NOT NULL AND ${scope(sql`project_id`)})::text AS merged,
      (SELECT coalesce(sum(tokens_in + tokens_out), 0) FROM claims WHERE status = 'active' AND ${scope(sql`project_id`)})::text AS in_flight`,
  );
  return toTotals(r);
}

/**
 * SQL for "dependency `d.dep` of manifest `m` has landed": it is merged, and the indexer has read
 * and verified the base branch since that merge was recorded. Claims start from the pinned commit,
 * so a dependent unlocked by the merge alone ran on a commit without the work it builds on (found
 * by the first real-model run). A merge is only reported once it is on the branch (GitHub moves
 * the ref first; a generic CI must do the same), so a head read after it contains it, whether the
 * pin moved then or already had. Until the next good index (push webhook, timer or Re-pin) the
 * dependency blocks; a failed index leaves dependencies that had landed alone.
 */
const DEP_LANDED = sql`EXISTS (
  SELECT 1 FROM manifests x JOIN projects pp ON pp.id = x.project_id
  WHERE x.project_id = m.project_id AND x.manifest_id = d.dep AND x.state = 'merged'
    AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.manifest_id = x.id AND r.merged_at >= coalesce(pp.branch_read_at, '-infinity')))`;

/** SQL for the dependencies of manifest `m` that have not landed yet (the task's `blocked_by`). */
export const DEPS_BLOCKING = sql`ARRAY(SELECT d.dep FROM unnest(m.depends_on) AS d(dep) WHERE NOT ${DEP_LANDED})`;

/** SQL for "every dependency of manifest `m` has landed" (see DEP_LANDED). */
export const DEPS_MERGED = sql`NOT EXISTS (SELECT 1 FROM unnest(m.depends_on) AS d(dep) WHERE NOT ${DEP_LANDED})`;

export async function taskCounts(q: Queryable, projectId: number): Promise<TaskCounts> {
  const r = await one<Record<keyof TaskCounts, string>>(
    q,
    sql`SELECT
        count(*) FILTER (WHERE m.state = 'open')::text AS open,
        count(*) FILTER (WHERE m.state = 'claimed')::text AS claimed,
        count(*) FILTER (WHERE m.state = 'delivered')::text AS delivered,
        count(*) FILTER (WHERE m.state = 'merged')::text AS merged,
        count(*) FILTER (WHERE m.state = 'failed')::text AS failed,
        count(*) FILTER (WHERE m.state = 'open' AND p.status = 'active' AND ${DEPS_MERGED})::text AS claimable
      FROM manifests m JOIN projects p ON p.id = m.project_id WHERE m.project_id = ${projectId}`,
  );
  return { open: num(r?.open), claimed: num(r?.claimed), delivered: num(r?.delivered), merged: num(r?.merged), failed: num(r?.failed), claimable: num(r?.claimable) };
}

export async function stats(ctx: AppContext): Promise<Schemas["Stats"]> {
  const r = await one<{ projects: string; donors: string; tasks_merged: string; tasks_delivered: string }>(
    ctx.db,
    sql`SELECT
      (SELECT count(*) FROM projects WHERE ${LISTED})::text AS projects,
      (SELECT count(DISTINCT user_id) FROM donor_project_standings WHERE project_id IN (SELECT id FROM projects WHERE ${LISTED}))::text AS donors,
      (SELECT count(*) FROM manifests WHERE state = 'merged' AND project_id IN (SELECT id FROM projects WHERE ${LISTED}))::text AS tasks_merged,
      (SELECT count(*) FROM manifests WHERE state IN ('delivered', 'merged') AND project_id IN (SELECT id FROM projects WHERE ${LISTED}))::text AS tasks_delivered`,
  );
  return { totals: await totals(ctx.db), projects: num(r?.projects), donors: num(r?.donors), tasks_merged: num(r?.tasks_merged), tasks_delivered: num(r?.tasks_delivered) };
}

/* ---- donor standings ---- */

interface StandingRow {
  handle: string;
  avatar_url: string | null;
  pledged: string;
  reported: string;
  delivered: string;
  merged: string;
  tasks_delivered: string;
  tasks_merged: string;
}

const toStanding = (ctx: AppContext, r: StandingRow): Schemas["DonorStanding"] => ({
  ...toUserRef(ctx, r),
  pledged: num(r.pledged),
  reported: num(r.reported),
  delivered: num(r.delivered),
  merged: num(r.merged),
  tasks_delivered: num(r.tasks_delivered),
  tasks_merged: num(r.tasks_merged),
});

/** Leaderboard: delivered desc. `projectId` scopes it to one project, otherwise all listed projects. */
function standingsSql(projectId: number | undefined): SQL {
  const scope = projectId !== undefined ? sql`s.project_id = ${projectId}` : sql`s.project_id IN (SELECT id FROM projects WHERE ${LISTED})`;
  return sql`SELECT u.id AS user_id, u.handle, u.avatar_url,
        sum(s.pledged)::text AS pledged, sum(s.reported)::text AS reported, sum(s.delivered)::text AS delivered, sum(s.merged)::text AS merged,
        sum(s.tasks_delivered)::text AS tasks_delivered, sum(s.tasks_merged)::text AS tasks_merged
      FROM donor_project_standings s JOIN users u ON u.id = s.user_id
      WHERE ${scope} AND NOT u.banned
      GROUP BY u.id
      ORDER BY sum(s.delivered) DESC, sum(s.merged) DESC, sum(s.reported) DESC, u.id ASC`;
}

export async function projectDonors(ctx: AppContext, projectId: number): Promise<Schemas["DonorStanding"][]> {
  return (await rows<StandingRow>(ctx.db, sql`${standingsSql(projectId)} LIMIT 1000`)).map((r) => toStanding(ctx, r));
}

export async function listDonors(ctx: AppContext, opts: { limit: number; cursor?: string }): Promise<{ items: Schemas["DonorStanding"][]; next_cursor: string | null }> {
  const offset = offsetOf(opts.cursor);
  const list = await rows<StandingRow>(ctx.db, sql`${standingsSql(undefined)} LIMIT ${opts.limit + 1} OFFSET ${offset}`);
  return pageByOffset(list.map((r) => toStanding(ctx, r)), opts.limit, offset);
}

/* ---- ledger entries ---- */

interface EntryRow {
  id: string;
  type: "pledge" | "report" | "delivery" | "merge";
  at: string;
  tokens: string;
  handle: string;
  avatar_url: string | null;
  slug: string;
  manifest_id: string | null;
  title: string | null;
  report_status: string | null;
  pr_url: string | null;
  ci_run_url: string | null;
  branch: string | null;
  head_sha: string | null;
  delivery: Schemas["LedgerEntry"]["delivery"];
}

const toEntry = (ctx: AppContext, r: EntryRow): Schemas["LedgerEntry"] => ({
  id: r.id,
  type: r.type,
  at: iso(r.at),
  donor: toUserRef(ctx, r),
  project: r.slug,
  tokens: num(r.tokens),
  task_id: r.manifest_id ? `${r.slug}:${r.manifest_id}` : null,
  task_title: r.title,
  report_status: r.report_status,
  pr_url: r.pr_url,
  ci_run_url: r.ci_run_url,
  branch: r.branch,
  head_sha: r.head_sha,
  delivery: r.type === "report" ? (r.delivery ?? null) : null,
});

async function entries(ctx: AppContext, where: SQL, limit: number, cursor?: string): Promise<{ items: Schemas["LedgerEntry"][]; next_cursor: string | null }> {
  const c = decodeCursor(cursor);
  let before: SQL = sql``;
  if (c) {
    if (typeof c.a !== "string" || typeof c.i !== "string" || Number.isNaN(Date.parse(c.a))) throw validation("/cursor", "cursor is not valid");
    before = sql`AND (e.at, e.id) < (${c.a}::timestamptz, ${c.i})`;
  }
  const list = await rows<EntryRow & { at_exact: string }>(
    ctx.db,
    sql`SELECT e.id, e.type, e.at, to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_exact, e.tokens::text AS tokens,
          u.handle, u.avatar_url, p.slug, m.manifest_id, m.title, e.report_status, e.pr_url, e.ci_run_url, e.branch, e.head_sha, e.delivery
        FROM ledger_entries e
        JOIN users u ON u.id = e.user_id
        JOIN projects p ON p.id = e.project_id
        LEFT JOIN manifests m ON m.id = e.manifest_id
        WHERE ${where} ${before}
        ORDER BY e.at DESC, e.id DESC LIMIT ${limit + 1}`,
  );
  const more = list.length > limit;
  const items = more ? list.slice(0, limit) : list;
  const last = items[items.length - 1];
  return { items: items.map((r) => toEntry(ctx, r)), next_cursor: more && last ? encodeCursor({ a: last.at_exact, i: last.id }) : null };
}

export async function projectLedger(
  ctx: AppContext,
  project: { id: number; slug: string; tokenGoal: number },
  opts: { limit: number; cursor?: string },
): Promise<Schemas["Ledger"]> {
  const [t, donors, page] = await Promise.all([
    totals(ctx.db, project.id),
    projectDonors(ctx, project.id),
    entries(ctx, sql`e.project_id = ${project.id}`, opts.limit, opts.cursor),
  ]);
  return { project: project.slug, token_goal: project.tokenGoal, totals: t, donors, entries: page.items, next_cursor: page.next_cursor };
}

/* ---- donor profile ---- */

/** Consecutive UTC days with a delivered run, ending today or yesterday. */
export function streakDays(days: string[], today: string): number {
  const set = new Set(days);
  const dayMs = 86_400_000;
  let cursor = Date.parse(`${today}T00:00:00Z`);
  if (!set.has(today)) cursor -= dayMs;
  let n = 0;
  while (set.has(new Date(cursor).toISOString().slice(0, 10))) {
    n++;
    cursor -= dayMs;
  }
  return n;
}

export async function donorProfile(ctx: AppContext, handle: string): Promise<Schemas["Donor"]> {
  const user = await one<{ id: string; handle: string; avatar_url: string | null; github_login: string | null; created_at: string; banned: boolean }>(
    ctx.db,
    sql`SELECT id, handle, avatar_url, github_login, created_at, banned FROM users WHERE handle = ${handle}`,
  );
  if (!user || user.banned) throw new Problem("not-found", `No donor ${handle}.`);
  const uid = Number(user.id);
  const perProject = await rows<{ slug: string; name: string; pledged: string; reported: string; delivered: string; merged: string; tasks_delivered: string; tasks_merged: string }>(
    ctx.db,
    sql`SELECT p.slug, p.name, s.pledged::text, s.reported::text, s.delivered::text, s.merged::text, s.tasks_delivered::text, s.tasks_merged::text
        FROM donor_project_standings s JOIN projects p ON p.id = s.project_id
        WHERE s.user_id = ${uid} AND p.status IN ('active', 'paused')
        ORDER BY s.delivered DESC, s.pledged DESC, p.slug`,
  );
  const sum = (k: "pledged" | "reported" | "delivered" | "merged" | "tasks_delivered" | "tasks_merged") => perProject.reduce((n, r) => n + num(r[k]), 0);
  const delivered = sum("delivered");
  const now = ctx.clock.now();
  const days = await rows<{ day: string }>(
    ctx.db,
    sql`SELECT DISTINCT to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM reports
        WHERE user_id = ${uid} AND delivered_at IS NOT NULL AND delivered_at <= ${tsParam(now)}`,
  );
  let rank: number | null = null;
  if (delivered > 0) {
    const r = await one<{ ahead: string }>(
      ctx.db,
      sql`SELECT count(*)::text AS ahead FROM (
            SELECT s.user_id FROM donor_project_standings s JOIN users u ON u.id = s.user_id
            WHERE s.project_id IN (SELECT id FROM projects WHERE ${LISTED}) AND NOT u.banned
            GROUP BY s.user_id HAVING sum(s.delivered) > ${delivered}) x`,
    );
    rank = num(r?.ahead) + 1;
  }
  const recent = await entries(ctx, sql`e.user_id = ${uid} AND p.status IN ('active', 'paused')`, 20);
  return {
    ...toUserRef(ctx, user),
    pledged: sum("pledged"),
    reported: sum("reported"),
    delivered,
    merged: sum("merged"),
    tasks_delivered: sum("tasks_delivered"),
    tasks_merged: sum("tasks_merged"),
    github_login: user.github_login,
    joined_at: iso(user.created_at),
    projects_backed: perProject.length,
    streak_days: streakDays(days.map((d) => d.day), now.toISOString().slice(0, 10)),
    rank,
    projects: perProject.map((r) => ({ slug: r.slug, name: r.name, pledged: num(r.pledged), delivered: num(r.delivered), merged: num(r.merged) })),
    recent: recent.items,
  };
}
