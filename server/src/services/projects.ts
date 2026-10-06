import { eq, sql, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { iso, isoOrNull, num, one, rows, tsParam, type Queryable } from "../db/client.js";
import { projects, users } from "../db/schema.js";
import { offsetOf, pageByOffset } from "../lib/cursor.js";
import { fingerprint } from "../lib/minisign.js";
import type { BodyOf, QueryOf, Schemas } from "../lib/openapi.js";
import { Problem } from "../lib/problem.js";
import { toUserRef, type Principal, type UserRow } from "./auth.js";
import { appendEvent } from "./events.js";
import { getInstance, type InstanceRow } from "./instance.js";
import { DEPS_MERGED } from "./ledger.js";

export type ProjectRow = typeof projects.$inferSelect;
type Project = Schemas["Project"];

interface ProjectViewRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  repo_url: string;
  homepage: string | null;
  language: string | null;
  tags: string[];
  status: Schemas["ProjectStatus"];
  ci_provider: "github" | "generic";
  base_branch: string;
  follow_branch: boolean;
  pubkey: string;
  pinned_commit: string;
  lock_sha256: string | null;
  token_goal: string;
  created_at: string;
  last_indexed_at: string | null;
  index_error: string | null;
  m_handle: string;
  m_avatar: string | null;
  pledged: string;
  reported: string;
  delivered: string;
  merged: string;
  in_flight: string;
  velocity_7d: string;
  donors: string;
  t_open: string;
  t_claimed: string;
  t_delivered: string;
  t_merged: string;
  t_failed: string;
  t_claimable: string;
  last_activity_at: string | null;
}

/** One row per project with every computed column the `Project` schema needs. */
function projectView(now: Date): SQL {
  const tok = sql`coalesce(sum(tokens_in + tokens_out), 0)`;
  return sql`
    SELECT p.id, p.slug, p.name, p.description, p.repo_url, p.homepage, p.language, p.tags, p.status, p.ci_provider,
           p.base_branch, p.follow_branch, p.pubkey, p.pinned_commit, p.lock_sha256, p.token_goal, p.created_at,
           p.last_indexed_at, p.index_error, p.maintainer_id, p.search,
           u.handle AS m_handle, u.avatar_url AS m_avatar,
           (SELECT coalesce(sum(token_amount), 0) FROM pledges WHERE project_id = p.id) AS pledged,
           (SELECT ${tok} FROM reports WHERE project_id = p.id AND NOT flagged_late)
             + (SELECT ${tok} FROM burns WHERE project_id = p.id) AS reported,
           (SELECT ${tok} FROM reports WHERE project_id = p.id AND delivered_at IS NOT NULL) AS delivered,
           (SELECT ${tok} FROM reports WHERE project_id = p.id AND merged_at IS NOT NULL) AS merged,
           (SELECT ${tok} FROM claims WHERE project_id = p.id AND status = 'active') AS in_flight,
           (SELECT ${tok} FROM reports WHERE project_id = p.id AND delivered_at > ${tsParam(new Date(now.getTime() - 7 * 86_400_000))} AND delivered_at <= ${tsParam(now)}) AS velocity_7d,
           (SELECT count(*) FROM donor_project_standings WHERE project_id = p.id) AS donors,
           t.t_open, t.t_claimed, t.t_delivered, t.t_merged, t.t_failed, t.t_claimable,
           (SELECT at FROM events WHERE project_id = p.id AND public ORDER BY id DESC LIMIT 1) AS last_activity_at
    FROM projects p
    JOIN users u ON u.id = p.maintainer_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE m.state = 'open') AS t_open,
             count(*) FILTER (WHERE m.state = 'claimed') AS t_claimed,
             count(*) FILTER (WHERE m.state = 'delivered') AS t_delivered,
             count(*) FILTER (WHERE m.state = 'merged') AS t_merged,
             count(*) FILTER (WHERE m.state = 'failed') AS t_failed,
             count(*) FILTER (WHERE m.state = 'open' AND p.status = 'active' AND ${DEPS_MERGED}) AS t_claimable
      FROM manifests m WHERE m.project_id = p.id
    ) t ON true`;
}

export function trustOf(instance: InstanceRow, mergedTasks: number): Schemas["ProjectTrust"] {
  const established = mergedTasks >= instance.establishedAfterMergedTasks;
  return {
    tier: established ? "established" : "new",
    merged_tasks: mergedTasks,
    max_tokens_per_task: established ? null : instance.newProjectMaxTokensPerTask,
    max_tokens_per_day: established ? null : instance.newProjectMaxTokensPerDay,
  };
}

export const projectGlobalId = (ctx: AppContext, slug: string): string => `${ctx.config.baseUrl}/${slug}`;

export function lockUrl(repoUrl: string, commit: string): string | null {
  return /^https:\/\/github\.com\//i.test(repoUrl) ? `${repoUrl}/blob/${commit}/tasks/MANIFEST.lock` : null;
}

export function commitUrl(repoUrl: string, commit: string): string | null {
  return /^https:\/\/github\.com\//i.test(repoUrl) ? `${repoUrl}/commit/${commit}` : null;
}

function toProject(ctx: AppContext, instance: InstanceRow, r: ProjectViewRow): Project {
  return {
    id: projectGlobalId(ctx, r.slug),
    slug: r.slug,
    name: r.name,
    description: r.description,
    repo_url: r.repo_url,
    homepage: r.homepage,
    language: r.language,
    tags: r.tags ?? [],
    status: r.status,
    ci_provider: r.ci_provider,
    base_branch: r.base_branch,
    follow_branch: r.follow_branch,
    maintainer: toUserRef(ctx, { handle: r.m_handle, avatar_url: r.m_avatar }),
    pubkey: r.pubkey,
    pubkey_fingerprint: fingerprint(r.pubkey),
    pinned_commit: r.pinned_commit,
    lock_sha256: r.lock_sha256,
    lock_url: lockUrl(r.repo_url, r.pinned_commit),
    commit_url: commitUrl(r.repo_url, r.pinned_commit),
    token_goal: num(r.token_goal),
    totals: { pledged: num(r.pledged), reported: num(r.reported), delivered: num(r.delivered), merged: num(r.merged), in_flight: num(r.in_flight) },
    tasks: { open: num(r.t_open), claimed: num(r.t_claimed), delivered: num(r.t_delivered), merged: num(r.t_merged), failed: num(r.t_failed), claimable: num(r.t_claimable) },
    donors: num(r.donors),
    velocity_7d: num(r.velocity_7d),
    trust: trustOf(instance, num(r.t_merged)),
    created_at: iso(r.created_at),
    last_activity_at: isoOrNull(r.last_activity_at),
    last_indexed_at: isoOrNull(r.last_indexed_at),
    index_error: r.index_error,
  };
}

const ORDER: Record<NonNullable<QueryOf<"listProjects">["sort"]>, SQL> = {
  trending: sql`v.velocity_7d DESC, v.delivered DESC, v.created_at DESC, v.id DESC`,
  recent: sql`v.created_at DESC, v.id DESC`,
  active: sql`v.last_activity_at DESC NULLS LAST, v.id DESC`,
  delivered: sql`v.delivered DESC, v.created_at DESC, v.id DESC`,
};

export interface ProjectListOptions {
  q?: string;
  language?: string;
  tag?: string;
  /** Explicit statuses to include. */
  statuses: Schemas["ProjectStatus"][];
  needsDonors?: boolean;
  sort: keyof typeof ORDER;
  maintainer?: string;
  limit: number;
  cursor?: string;
}

export async function listProjects(ctx: AppContext, o: ProjectListOptions): Promise<{ items: Project[]; next_cursor: string | null }> {
  const offset = offsetOf(o.cursor);
  const conds: SQL[] = [sql`v.status IN (${sql.join(o.statuses.map((s) => sql`${s}`), sql`, `)})`];
  if (o.q && o.q.trim()) {
    const like = `%${o.q.trim().toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
    conds.push(sql`(v.search @@ websearch_to_tsquery('english', ${o.q.trim()}) OR lower(v.name) LIKE ${like} OR v.slug LIKE ${like})`);
  }
  if (o.language) conds.push(sql`lower(v.language) = ${o.language.toLowerCase()}`);
  if (o.tag) conds.push(sql`${o.tag.toLowerCase()} = ANY(v.tags)`);
  if (o.needsDonors === true) conds.push(sql`v.t_claimable > 0`);
  if (o.needsDonors === false) conds.push(sql`v.t_claimable = 0`);
  if (o.maintainer) conds.push(sql`v.m_handle = ${o.maintainer.toLowerCase()}`);
  const instance = await getInstance(ctx.db);
  const list = await rows<ProjectViewRow>(
    ctx.db,
    sql`SELECT v.* FROM (${projectView(ctx.clock.now())}) v WHERE ${sql.join(conds, sql` AND `)} ORDER BY ${ORDER[o.sort]} LIMIT ${o.limit + 1} OFFSET ${offset}`,
  );
  return pageByOffset(list.map((r) => toProject(ctx, instance, r)), o.limit, offset);
}

export async function getProjectRow(q: Queryable, slug: string): Promise<ProjectRow | undefined> {
  const [row] = await q.select().from(projects).where(eq(projects.slug, slug));
  return row;
}

/** Pending and removed projects exist only for their maintainer and admins. */
export function canSee(project: Pick<ProjectRow, "status" | "maintainerId">, viewer: UserRow | null | undefined): boolean {
  if (project.status === "active" || project.status === "paused") return true;
  return Boolean(viewer && (viewer.role === "admin" || viewer.id === project.maintainerId));
}

export async function visibleProject(ctx: AppContext, slug: string, viewer: UserRow | null | undefined): Promise<ProjectRow> {
  const row = await getProjectRow(ctx.db, slug);
  if (!row || !canSee(row, viewer)) throw new Problem("not-found", `No project ${slug}.`);
  return row;
}

export async function projectById(ctx: AppContext, id: number, q: Queryable = ctx.db): Promise<Project> {
  const instance = await getInstance(q);
  const r = await one<ProjectViewRow>(q, sql`SELECT v.* FROM (${projectView(ctx.clock.now())}) v WHERE v.id = ${id}`);
  if (!r) throw new Problem("not-found", "No such project.");
  return toProject(ctx, instance, r);
}

export function requireMaintainer(project: ProjectRow, who: Principal): void {
  if (who.user.role !== "admin" && who.user.id !== project.maintainerId) throw new Problem("forbidden", "Only the project's maintainer or an admin can do this.");
}

export async function updateProject(ctx: AppContext, who: Principal, slug: string, patch: BodyOf<"updateProject">): Promise<Project> {
  const project = await visibleProject(ctx, slug, who.user);
  requireMaintainer(project, who);
  if (patch.status !== undefined && patch.status !== project.status && who.user.role !== "admin" && (project.status === "pending" || project.status === "removed")) {
    throw new Problem("forbidden", `A ${project.status} project can only be activated by an admin.`);
  }
  await ctx.db.transaction(async (tx) => {
    const set: Partial<typeof projects.$inferInsert> = {};
    if (patch.status !== undefined && patch.status !== project.status) set.status = patch.status;
    if (patch.token_goal !== undefined) set.tokenGoal = patch.token_goal;
    if (patch.follow_branch !== undefined) set.followBranch = patch.follow_branch;
    if (Object.keys(set).length === 0) return;
    await tx.update(projects).set(set).where(eq(projects.id, project.id));
    if (set.status) {
      await appendEvent(ctx, tx, { actor: who.user.handle, action: set.status === "paused" ? "project.paused" : "project.resumed", projectId: project.id, project: slug, payload: { from: project.status, to: set.status } });
    }
    if (set.tokenGoal !== undefined && set.tokenGoal !== project.tokenGoal) {
      await appendEvent(ctx, tx, { actor: who.user.handle, action: "project.goal_changed", projectId: project.id, project: slug, payload: { from: project.tokenGoal, to: set.tokenGoal } });
    }
    if (set.followBranch !== undefined && set.followBranch !== project.followBranch) {
      await appendEvent(ctx, tx, { actor: who.user.handle, action: "project.follow_branch_changed", projectId: project.id, project: slug, payload: { follow_branch: set.followBranch } });
    }
  });
  return projectById(ctx, project.id);
}

const MODERATION_EVENT: Record<Schemas["ProjectStatus"], string> = { active: "project.activated", paused: "project.paused", removed: "project.removed", pending: "project.pending" };

export async function moderateProject(ctx: AppContext, who: Principal, slug: string, status: Schemas["ProjectStatus"]): Promise<Project> {
  const project = await getProjectRow(ctx.db, slug);
  if (!project) throw new Problem("not-found", `No project ${slug}.`);
  if (project.status !== status) {
    await ctx.db.transaction(async (tx) => {
      if (project.status === "removed") {
        // Coming back from removal must not collide with a repo registered in the meantime.
        const clash = await one<{ id: string }>(tx, sql`SELECT id FROM projects WHERE repo_key = ${project.repoKey} AND status <> 'removed' AND id <> ${project.id}`);
        if (clash) throw new Problem("repo-already-registered", "Another project now uses this repository.");
      }
      await tx.update(projects).set({ status }).where(eq(projects.id, project.id));
      await appendEvent(ctx, tx, { actor: who.user.handle, action: MODERATION_EVENT[status], projectId: project.id, project: slug, payload: { from: project.status, to: status, by: "admin" } });
    });
  }
  return projectById(ctx, project.id);
}

export async function listAllProjects(ctx: AppContext, opts: { limit: number; cursor?: string }): Promise<{ items: Project[]; next_cursor: string | null }> {
  return listProjects(ctx, { statuses: ["pending", "active", "paused", "removed"], sort: "recent", limit: opts.limit, cursor: opts.cursor });
}

export async function maintainerHandle(q: Queryable, project: ProjectRow): Promise<string> {
  const [u] = await q.select({ handle: users.handle }).from(users).where(eq(users.id, project.maintainerId));
  return u?.handle ?? "unknown";
}
