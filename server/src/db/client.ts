import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql, type SQL } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.js";
import { MIGRATIONS_DIR } from "../paths.js";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything queries can run on: the pool or an open transaction. */
export type Queryable = Db | Tx;

export interface Database {
  db: Db;
  client: postgres.Sql;
  url: string;
  close(): Promise<void>;
}

export function connect(url: string, opts: { max?: number } = {}): Database {
  const client = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connection: { TimeZone: "UTC", application_name: "agentfund" },
  });
  const db = drizzle(client, { schema });
  return { db, client, url, close: () => client.end({ timeout: 5 }) };
}

/** Applies pending SQL migrations. Safe to run concurrently from several replicas. */
export async function runMigrations(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Serialise replicas booting at the same time.
    await client`SELECT pg_advisory_lock(4711001)`;
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client`SELECT pg_advisory_unlock(4711001)`.catch(() => undefined);
    await client.end({ timeout: 5 });
  }
}

/** Timestamp parameter. Raw `sql` fragments get ISO strings; the driver's Date mapping is bypassed by drizzle. */
export const tsParam = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** A text[] parameter built from a JS array (drizzle would otherwise expand it into a row). */
export const textArray = (values: readonly string[]): SQL => sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))::text[]`;

/** Rows of a raw query, typed by the caller at this boundary. */
export async function rows<T>(q: Queryable, query: SQL): Promise<T[]> {
  const res = await q.execute(query);
  return res as unknown as T[];
}

export async function one<T>(q: Queryable, query: SQL): Promise<T | undefined> {
  return (await rows<T>(q, query))[0];
}

/** Postgres timestamptz text (or Date) → RFC 3339 UTC. */
export function iso(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  const s = v.includes("T") ? v : v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  return new Date(s).toISOString();
}
export const isoOrNull = (v: string | Date | null | undefined): string | null => (v === null || v === undefined ? null : iso(v));
export const num = (v: string | number | bigint | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
