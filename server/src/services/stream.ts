/**
 * Live stream fan-out. Changes are announced with Postgres NOTIFY (an insert trigger on
 * `events`, plus `notifyTotals` for heartbeats), so every API replica hears every change;
 * each replica then coalesces `totals` frames to at most ~4 per second per scope.
 */
import { sql } from "drizzle-orm";
import type { Database, Queryable } from "../db/client.js";
import type { Schemas } from "../lib/openapi.js";
import type { Logger } from "../log.js";
import { eventById, toEvent } from "./events.js";
import { taskCounts, totals } from "./ledger.js";

export const CHANNEL = "agentfund";
const MIN_INTERVAL_MS = 250;

/** In-flight token movement has no audit event; this is its change signal. */
export async function notifyTotals(q: Queryable, projectId: number): Promise<void> {
  await q.execute(sql`SELECT pg_notify(${CHANNEL}, ${JSON.stringify({ t: "totals", p: projectId })})`);
}

export interface Subscriber {
  /** Project id, or null for the instance-wide stream. */
  projectId: number | null;
  send(event: "totals" | "event", data: unknown): void;
  close(): void;
}

type ScopeKey = number | "instance";

export class StreamHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly timers = new Map<ScopeKey, NodeJS.Timeout>();
  private readonly lastSent = new Map<ScopeKey, number>();
  private unlisten: (() => Promise<void>) | null = null;
  private stopped = false;

  constructor(private readonly database: Database, private readonly log: Logger) {}

  async start(): Promise<void> {
    const sub = await this.database.client.listen(CHANNEL, (payload) => {
      void this.onNotify(payload).catch((err) => this.log.warn("stream notify handling failed", { err }));
    });
    this.unlisten = () => sub.unlisten();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const s of [...this.subscribers]) s.close();
    this.subscribers.clear();
    const unlisten = this.unlisten;
    this.unlisten = null;
    await unlisten?.().catch(() => undefined);
  }

  get size(): number {
    return this.subscribers.size;
  }

  subscribe(s: Subscriber): () => void {
    this.subscribers.add(s);
    return () => this.subscribers.delete(s);
  }

  async snapshot(projectId: number | null): Promise<Schemas["StreamTotals"]> {
    const db = this.database.db;
    if (projectId === null) return { scope: "instance", project: null, totals: await totals(db), token_goal: null, tasks: null };
    const [p] = (await db.execute(sql`SELECT slug, token_goal FROM projects WHERE id = ${projectId}`)) as unknown as { slug: string; token_goal: string }[];
    return { scope: "project", project: p?.slug ?? null, totals: await totals(db, projectId), token_goal: p ? Number(p.token_goal) : null, tasks: await taskCounts(db, projectId) };
  }

  private async onNotify(payload: string): Promise<void> {
    if (this.stopped || this.subscribers.size === 0) return;
    let msg: { t?: string; id?: number; p?: number | null };
    try {
      msg = JSON.parse(payload) as typeof msg;
    } catch {
      return;
    }
    const projectId = typeof msg.p === "number" ? msg.p : null;
    if (msg.t === "event" && typeof msg.id === "number") {
      const row = await eventById(this.database.db, msg.id);
      if (row?.public) {
        const data = toEvent(row);
        let listed: boolean | null = null;
        for (const s of this.subscribers) {
          if (s.projectId !== null) {
            if (s.projectId === projectId) s.send("event", data);
            continue;
          }
          if (projectId !== null && listed === null) {
            const [p] = (await this.database.db.execute(sql`SELECT status FROM projects WHERE id = ${projectId}`)) as unknown as { status: string }[];
            listed = p?.status === "active" || p?.status === "paused";
          }
          if (projectId === null || listed) s.send("event", data);
        }
      }
    }
    if (projectId !== null) this.markDirty(projectId);
    this.markDirty("instance");
  }

  private markDirty(scope: ScopeKey): void {
    if (this.timers.has(scope)) return;
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - (this.lastSent.get(scope) ?? 0)));
    this.timers.set(
      scope,
      setTimeout(() => {
        this.timers.delete(scope);
        this.lastSent.set(scope, Date.now());
        void this.flush(scope).catch((err) => this.log.warn("stream totals flush failed", { err }));
      }, wait),
    );
  }

  private async flush(scope: ScopeKey): Promise<void> {
    const projectId = scope === "instance" ? null : scope;
    const targets = [...this.subscribers].filter((s) => s.projectId === projectId);
    if (targets.length === 0) return;
    const frame = await this.snapshot(projectId);
    for (const s of targets) s.send("totals", frame);
  }
}
