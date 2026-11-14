import { sql, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { iso, num, rows, type Queryable } from "../db/client.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import type { Schemas } from "../lib/openapi.js";
import { validation } from "../lib/problem.js";
import { toUserRef } from "./auth.js";
import { DEPS_MERGED } from "./ledger.js";

type Task = Schemas["Task"];
type Report = Schemas["Report"];

export interface ReportViewRow {
  id: string;
  public_id: string;
  claim_public_id: string;
  manifest_pk: string;
  mid: string;
  slug: string;
  handle: string;
  avatar_url: string | null;
  home_id: string | null;
  status: Schemas["ReportStatus"];
  tokens_in: string;
  tokens_out: string;
  cost_estimate: number;
  branch: string | null;
  pr_url: string | null;
  head_sha: string | null;
  verify_exit_code: number | null;
  log_digest: string;
  duration_seconds: number | null;
  runner: string | null;
  model: string | null;
  message: string | null;
  flagged_late: boolean;
  delivery: Report["delivery"];
  ci_provider: string | null;
  ci_conclusion: string | null;
  ci_run_url: string | null;
  ci_received_at: string | null;
  created_at: string;
}

export const REPORT_VIEW = sql`
  SELECT r.id, r.public_id, c.public_id AS claim_public_id, r.manifest_id AS manifest_pk, m.manifest_id AS mid, p.slug,
         u.handle, u.avatar_url, u.home_id, r.status, r.tokens_in, r.tokens_out, r.cost_estimate, r.branch, r.pr_url, r.head_sha,
         r.verify_exit_code, r.log_digest, r.duration_seconds, r.runner, r.model, r.message, r.flagged_late, r.delivery,
         r.ci_provider, r.ci_conclusion, r.ci_run_url, r.ci_received_at, r.created_at, r.claim_id
  FROM reports r
  JOIN claims c ON c.id = r.claim_id
  JOIN manifests m ON m.id = r.manifest_id
  JOIN projects p ON p.id = r.project_id
  JOIN users u ON u.id = r.user_id`;

export const toReport = (ctx: AppContext, r: ReportViewRow): Report => ({
  id: r.public_id,
  claim_id: r.claim_public_id,
  task_id: `${r.slug}:${r.mid}`,
  project: r.slug,
  donor: toUserRef(ctx, r),
  status: r.status,
  tokens_in: num(r.tokens_in),
  tokens_out: num(r.tokens_out),
  cost_estimate: Number(r.cost_estimate),
  branch: r.branch,
  pr_url: r.pr_url,
  head_sha: r.head_sha,
  verify_exit_code: r.verify_exit_code,
  log_digest: r.log_digest,
  duration_seconds: r.duration_seconds,
  runner: r.runner,
  model: r.model,
  message: r.message,
  flagged_late: r.flagged_late,
  delivery: r.delivery,
  ci: r.ci_received_at && r.ci_conclusion ? { provider: r.ci_provider ?? "unknown", conclusion: r.ci_conclusion, run_url: r.ci_run_url, received_at: iso(r.ci_received_at) } : null,
  created_at: iso(r.created_at),
});

export async function reportById(ctx: AppContext, q: Queryable, id: number): Promise<Report> {
  const [r] = await rows<ReportViewRow>(q, sql`${REPORT_VIEW} WHERE r.id = ${id}`);
  if (!r) throw new Error("report vanished");
  return toReport(ctx, r);
}

interface TaskRow {
  id: string;
  slug: string;
  project_status: string;
  manifest_id: string;
  path: string;
  title: string;
  content_hash: string;
  commit: string;
  manifest: Schemas["Manifest"];
  depends_on: string[];
  state: Schemas["TaskState"];
  updated_at: string;
  blocked_by: string[];
  claimable: boolean;
  burn_in: string;
  burn_out: string;
  burn_runs: string;
  ac_handle: string | null;
  ac_avatar: string | null;
  ac_home: string | null;
  ac_claimed_at: string | null;
  ac_lease: string | null;
  ac_tokens: string | null;
  ac_phase: string | null;
}

const TASK_VIEW = sql`
  SELECT m.id, p.slug, p.status AS project_status, m.manifest_id, m.path, m.title, m.content_hash, m.commit, m.manifest,
         m.depends_on, m.state, m.updated_at,
         ARRAY(SELECT d.dep FROM unnest(m.depends_on) AS d(dep)
               WHERE NOT EXISTS (SELECT 1 FROM manifests x WHERE x.project_id = m.project_id AND x.manifest_id = d.dep AND x.state = 'merged')) AS blocked_by,
         (m.state = 'open' AND p.status = 'active' AND ${DEPS_MERGED}) AS claimable,
         b.burn_in, b.burn_out, b.burn_runs,
         cu.handle AS ac_handle, cu.avatar_url AS ac_avatar, cu.home_id AS ac_home, ac.claimed_at AS ac_claimed_at, ac.lease_expires_at AS ac_lease,
         (ac.tokens_in + ac.tokens_out) AS ac_tokens, ac.phase AS ac_phase
  FROM manifests m
  JOIN projects p ON p.id = m.project_id
  LEFT JOIN claims ac ON ac.manifest_id = m.id AND ac.status = 'active'
  LEFT JOIN users cu ON cu.id = ac.user_id
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(tokens_in), 0) AS burn_in, coalesce(sum(tokens_out), 0) AS burn_out, count(*) AS burn_runs
    FROM (SELECT tokens_in, tokens_out FROM reports WHERE manifest_id = m.id AND NOT flagged_late
          UNION ALL SELECT tokens_in, tokens_out FROM burns WHERE manifest_id = m.id) runs
  ) b ON true`;

async function hydrate(ctx: AppContext, q: Queryable, list: TaskRow[]): Promise<Task[]> {
  const latest = new Map<string, Report>();
  if (list.length) {
    const ids = sql.join(list.map((t) => sql`${Number(t.id)}`), sql`, `);
    const reps = await rows<ReportViewRow>(
      q,
      sql`SELECT * FROM (${REPORT_VIEW} WHERE r.manifest_id IN (${ids})) v
          WHERE v.id IN (SELECT max(id) FROM reports WHERE manifest_id IN (${ids}) GROUP BY manifest_id)`,
    );
    for (const r of reps) latest.set(String(r.manifest_pk), toReport(ctx, r));
  }
  return list.map((t) => ({
    id: `${t.slug}:${t.manifest_id}`,
    task_id: t.manifest_id,
    project: t.slug,
    title: t.title,
    state: t.state,
    content_hash: t.content_hash,
    manifest_path: t.path,
    commit: t.commit,
    manifest: t.manifest,
    depends_on: t.depends_on ?? [],
    blocked_by: t.blocked_by ?? [],
    claimable: t.claimable,
    burn: { tokens_in: num(t.burn_in), tokens_out: num(t.burn_out), total: num(t.burn_in) + num(t.burn_out), runs: num(t.burn_runs) },
    active_claim:
      t.ac_handle && t.ac_claimed_at && t.ac_lease
        ? { donor: toUserRef(ctx, { handle: t.ac_handle, avatar_url: t.ac_avatar, home_id: t.ac_home }), claimed_at: iso(t.ac_claimed_at), lease_expires_at: iso(t.ac_lease), tokens_so_far: num(t.ac_tokens), phase: t.ac_phase }
        : null,
    latest_report: latest.get(String(t.id)) ?? null,
    updated_at: iso(t.updated_at),
  }));
}

export async function listTasks(
  ctx: AppContext,
  projectId: number,
  opts: { state?: Schemas["TaskState"]; claimable?: boolean; limit: number; cursor?: string },
): Promise<{ items: Task[]; next_cursor: string | null }> {
  const c = decodeCursor(opts.cursor);
  const conds: SQL[] = [sql`v.project_id = ${projectId}`];
  if (c) {
    if (typeof c.t !== "string") throw validation("/cursor", "cursor is not valid");
    conds.push(sql`v.manifest_id > ${c.t}`);
  }
  if (opts.state) conds.push(sql`v.state = ${opts.state}`);
  if (opts.claimable !== undefined) conds.push(opts.claimable ? sql`v.claimable` : sql`NOT v.claimable`);
  const list = await rows<TaskRow>(
    ctx.db,
    sql`SELECT v.* FROM (SELECT tv.*, m2.project_id FROM (${TASK_VIEW}) tv JOIN manifests m2 ON m2.id = tv.id) v
        WHERE ${sql.join(conds, sql` AND `)} ORDER BY v.manifest_id ASC LIMIT ${opts.limit + 1}`,
  );
  const more = list.length > opts.limit;
  const page = more ? list.slice(0, opts.limit) : list;
  return { items: await hydrate(ctx, ctx.db, page), next_cursor: more ? encodeCursor({ t: page[page.length - 1]!.manifest_id }) : null };
}

export async function taskByRef(ctx: AppContext, projectId: number, manifestId: string): Promise<Task | null> {
  const list = await rows<TaskRow>(ctx.db, sql`SELECT tv.* FROM (${TASK_VIEW}) tv JOIN manifests m2 ON m2.id = tv.id WHERE m2.project_id = ${projectId} AND m2.manifest_id = ${manifestId}`);
  return (await hydrate(ctx, ctx.db, list))[0] ?? null;
}

export async function taskByPk(ctx: AppContext, q: Queryable, manifestPk: number): Promise<Task> {
  const list = await rows<TaskRow>(q, sql`SELECT tv.* FROM (${TASK_VIEW}) tv WHERE tv.id = ${manifestPk}`);
  const [task] = await hydrate(ctx, q, list);
  if (!task) throw new Error("task vanished");
  return task;
}
