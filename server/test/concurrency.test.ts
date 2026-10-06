import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Schemas } from "../src/lib/openapi.js";
import { createTestApp, type TestApp } from "./helpers/app.js";
import { setupProject } from "./helpers/scenario.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ env: { DB_POOL_MAX: "20" } });
  const admin = await t.login("root");
  await t.call("adminUpdateInstance", { token: admin, body: { max_active_claims_per_donor: 100, new_project_max_tokens_per_day: 1_000_000_000_000 } });
});
afterAll(async () => {
  await t.close();
});

async function donors(n: number, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) keys.push((await t.donor(`${prefix}-${i}`)).key);
  return keys;
}

describe("concurrent claims (SELECT … FOR UPDATE SKIP LOCKED)", () => {
  it("64 parallel claims on one open task: exactly one 201, the rest 409 task-not-open", async () => {
    await setupProject(t, "race", [{ id: "0001-only" }]);
    const keys = await donors(64, "racer");
    const results = await Promise.all(keys.map((key) => t.call<Schemas["Claim"]>("claimTask", { token: key, path: { task_id: "race:0001-only" } })));
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(63);
    expect(new Set(lost.map((r) => r.code))).toEqual(new Set(["task-not-open"]));
    const rows = (await t.ctx.db.execute(sql`SELECT count(*)::int AS n FROM claims c JOIN projects p ON p.id = c.project_id WHERE p.slug = 'race'`)) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(1);
    const events = (await t.call<Schemas["EventPage"]>("listProjectEvents", { path: { slug: "race" }, query: { limit: 100 } })).body.items;
    expect(events.filter((e) => e.action === "task.claimed")).toHaveLength(1);
  });

  it("the same donor racing itself also gets exactly one claim", async () => {
    await setupProject(t, "selfrace", [{ id: "0001-only" }]);
    const [key] = await donors(1, "solo");
    const results = await Promise.all(Array.from({ length: 50 }, () => t.call("claimTask", { token: key!, path: { task_id: "selfrace:0001-only" } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.code === "task-not-open")).toHaveLength(49);
  });

  it("12 tasks × 30 workers: every task is claimed exactly once, none twice", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(4, "0")}-t${i + 1}`);
    await setupProject(t, "swarm", ids.map((id) => ({ id })));
    const keys = await donors(30, "bee");
    const wins = new Map<string, number>();
    await Promise.all(
      keys.map(async (key, w) => {
        // Each worker walks the queue in its own order, like real workers polling claimable tasks.
        const order = [...ids].sort((a, b) => ((a.charCodeAt(3) * 31 + w * 17) % 13) - ((b.charCodeAt(3) * 31 + w * 17) % 13));
        for (const id of order) {
          const r = await t.call("claimTask", { token: key, path: { task_id: `swarm:${id}` } });
          expect([201, 409]).toContain(r.status);
          if (r.status === 201) wins.set(id, (wins.get(id) ?? 0) + 1);
          else expect(r.code).toBe("task-not-open");
        }
      }),
    );
    expect([...wins.keys()].sort()).toEqual(ids);
    expect([...wins.values()].every((n) => n === 1)).toBe(true);
    const rows = (await t.ctx.db.execute(
      sql`SELECT m.manifest_id, count(c.id)::int AS n, count(c.id) FILTER (WHERE c.status = 'active')::int AS active
          FROM manifests m JOIN projects p ON p.id = m.project_id LEFT JOIN claims c ON c.manifest_id = m.id
          WHERE p.slug = 'swarm' GROUP BY m.manifest_id`,
    )) as unknown as { manifest_id: string; n: number; active: number }[];
    expect(rows).toHaveLength(12);
    for (const r of rows) expect([r.n, r.active], r.manifest_id).toEqual([1, 1]);
  });

  it("the per-donor claim limit holds under a burst from one donor", async () => {
    const admin = await t.login("root");
    await t.call("adminUpdateInstance", { token: admin, body: { max_active_claims_per_donor: 3 } });
    const ids = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(4, "0")}-x${i + 1}`);
    await setupProject(t, "burst", ids.map((id) => ({ id })));
    const [key] = await donors(1, "greedy");
    const results = await Promise.all(ids.map((id) => t.call("claimTask", { token: key!, path: { task_id: `burst:${id}` } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.code === "claim-limit")).toHaveLength(7);
    await t.call("adminUpdateInstance", { token: admin, body: { max_active_claims_per_donor: 100 } });
  });

  it("the new-project daily cap holds under a burst across donors", async () => {
    const admin = await t.login("root");
    await t.call("adminUpdateInstance", { token: admin, body: { new_project_max_tokens_per_day: 4_000_000 } });
    const ids = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(4, "0")}-y${i + 1}`);
    await setupProject(t, "daily", ids.map((id) => ({ id, max_tokens: 1_000_000 })));
    const keys = await donors(10, "day");
    const results = await Promise.all(ids.map((id, i) => t.call("claimTask", { token: keys[i]!, path: { task_id: `daily:${id}` } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect(results.filter((r) => r.code === "project-daily-cap")).toHaveLength(6);
  });

  it("concurrent duplicate reports: one is recorded, the rest are already-reported", async () => {
    await setupProject(t, "dupes", [{ id: "0001-a" }]);
    const [key] = await donors(1, "dupe");
    const c = (await t.call<Schemas["Claim"]>("claimTask", { token: key!, path: { task_id: "dupes:0001-a" } })).body;
    const body = { status: "failed", tokens_in: 10, tokens_out: 5, cost_estimate: 0, log_digest: "b".repeat(64) };
    const results = await Promise.all(Array.from({ length: 20 }, () => t.call("reportClaim", { token: key!, path: { claim_id: c.claim_id }, body })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.code === "already-reported")).toHaveLength(19);
    const p = (await t.call<Schemas["Project"]>("getProject", { path: { slug: "dupes" } })).body;
    expect(p.totals.reported).toBe(15);
  });
});
