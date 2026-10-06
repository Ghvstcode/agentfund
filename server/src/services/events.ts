import { sql, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { iso, rows, tsParam, type Queryable } from "../db/client.js";
import { events } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { newId } from "../lib/ids.js";
import type { Schemas } from "../lib/openapi.js";
import { validation } from "../lib/problem.js";

export interface NewEvent {
  actor: string | null;
  action: string;
  projectId?: number | null;
  project?: string | null;
  taskId?: string | null;
  payload?: Record<string, unknown>;
  public?: boolean;
}

/**
 * Appends to the audit log. Call it inside the transaction that makes the change: the insert
 * trigger NOTIFYs every replica on commit, which is what drives the live stream.
 */
export async function appendEvent(ctx: AppContext, q: Queryable, e: NewEvent): Promise<void> {
  await q.insert(events).values({
    publicId: newId("evt"),
    at: ctx.clock.now(),
    actor: e.actor,
    action: e.action,
    projectId: e.projectId ?? null,
    project: e.project ?? null,
    taskId: e.taskId ?? null,
    payload: e.payload ?? {},
    public: e.public ?? true,
  });
}

export interface EventRow {
  id: string;
  public_id: string;
  at: string;
  actor: string | null;
  action: string;
  project_id: string | null;
  project: string | null;
  task_id: string | null;
  payload: Record<string, unknown>;
  public: boolean;
}

export const toEvent = (r: EventRow): Schemas["Event"] => ({
  id: r.public_id,
  at: iso(r.at),
  actor: r.actor,
  action: r.action,
  project: r.project,
  task_id: r.task_id,
  payload: r.payload ?? {},
});

export async function listEvents(ctx: AppContext, opts: { projectId?: number; limit: number; cursor?: string }): Promise<Schemas["EventPage"]> {
  const c = decodeCursor(opts.cursor);
  let before: SQL = sql``;
  if (c) {
    if (typeof c.i !== "number" || !Number.isSafeInteger(c.i)) throw validation("/cursor", "cursor is not valid");
    before = sql`AND e.id < ${c.i}`;
  }
  // Instance-wide feed hides events of projects that are not publicly listed.
  const scope = opts.projectId !== undefined
    ? sql`e.project_id = ${opts.projectId}`
    : sql`(e.project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = e.project_id AND p.status IN ('active', 'paused')))`;
  const list = await rows<EventRow>(
    ctx.db,
    sql`SELECT e.* FROM events e WHERE e.public AND ${scope} ${before} ORDER BY e.id DESC LIMIT ${opts.limit + 1}`,
  );
  const more = list.length > opts.limit;
  const items = more ? list.slice(0, opts.limit) : list;
  return { items: items.map(toEvent), next_cursor: more ? encodeCursor({ i: Number(items[items.length - 1]!.id) }) : null };
}

export async function eventById(q: Queryable, id: number): Promise<EventRow | undefined> {
  return (await rows<EventRow>(q, sql`SELECT * FROM events WHERE id = ${id}`))[0];
}

export async function recentFeedEvents(ctx: AppContext, limit: number): Promise<EventRow[]> {
  return rows<EventRow>(
    ctx.db,
    sql`SELECT e.* FROM events e JOIN projects p ON p.id = e.project_id
        WHERE e.public AND e.action IN ('project.created', 'task.delivered') AND p.status IN ('active', 'paused')
          AND e.at <= ${tsParam(ctx.clock.now())}
        ORDER BY e.id DESC LIMIT ${limit}`,
  );
}
