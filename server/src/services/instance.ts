import { eq } from "drizzle-orm";
import { APP_NAME } from "../constants.js";
import type { AppContext } from "../context.js";
import type { Queryable } from "../db/client.js";
import { instances } from "../db/schema.js";
import { generateKeyPair } from "../lib/minisign.js";
import type { BodyOf, Schemas } from "../lib/openapi.js";
import type { Config } from "../config.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/client.js";

export type InstanceRow = typeof instances.$inferSelect;

/**
 * Creates the instance's own row on first boot: Ed25519 identity and a webhook secret are
 * generated here and persisted, so a clean `docker compose up` needs no secrets at all.
 * Name and description from the environment only seed the row; afterwards the admin API owns them.
 */
export async function ensureInstance(db: Db, config: Config, clock: Clock): Promise<InstanceRow> {
  const now = clock.now();
  const pair = generateKeyPair();
  await db
    .insert(instances)
    .values({
      id: 1,
      name: config.instanceName ?? APP_NAME,
      description: config.instanceDescription ?? "Fund open-source work with agent time.",
      baseUrl: config.baseUrl,
      pubkey: pair.publicKey,
      secretKey: pair.secretSeed.toString("base64"),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [row] = await db.update(instances).set({ baseUrl: config.baseUrl }).where(eq(instances.id, 1)).returning();
  if (!row) throw new Error("instance row missing after bootstrap");
  return row;
}

export async function getInstance(q: Queryable): Promise<InstanceRow> {
  const [row] = await q.select().from(instances).where(eq(instances.id, 1));
  if (!row) throw new Error("instance row missing");
  return row;
}

export const toInstanceConfig = (row: InstanceRow): Schemas["InstanceConfig"] => ({
  name: row.name,
  description: row.description,
  project_creation: row.projectCreation === "approval" ? "approval" : "open",
  lease_seconds: row.leaseSeconds,
  new_project_max_tokens_per_task: row.newProjectMaxTokensPerTask,
  new_project_max_tokens_per_day: row.newProjectMaxTokensPerDay,
  established_after_merged_tasks: row.establishedAfterMergedTasks,
  max_active_claims_per_donor: row.maxActiveClaimsPerDonor,
});

export async function updateInstance(ctx: AppContext, patch: BodyOf<"adminUpdateInstance">): Promise<InstanceRow> {
  const set: Partial<typeof instances.$inferInsert> = { updatedAt: ctx.clock.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.project_creation !== undefined) set.projectCreation = patch.project_creation;
  if (patch.lease_seconds !== undefined) set.leaseSeconds = patch.lease_seconds;
  if (patch.new_project_max_tokens_per_task !== undefined) set.newProjectMaxTokensPerTask = patch.new_project_max_tokens_per_task;
  if (patch.new_project_max_tokens_per_day !== undefined) set.newProjectMaxTokensPerDay = patch.new_project_max_tokens_per_day;
  if (patch.established_after_merged_tasks !== undefined) set.establishedAfterMergedTasks = patch.established_after_merged_tasks;
  if (patch.max_active_claims_per_donor !== undefined) set.maxActiveClaimsPerDonor = patch.max_active_claims_per_donor;
  const [row] = await ctx.db.update(instances).set(set).where(eq(instances.id, 1)).returning();
  if (!row) throw new Error("instance row missing");
  return row;
}
