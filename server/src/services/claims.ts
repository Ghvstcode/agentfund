/** Claims, leases, heartbeats, reports and releases — protocol.md §4, §5, §8. */
import { and, eq, sql } from "drizzle-orm";
import { HEARTBEAT_INTERVAL_SECONDS } from "../constants.js";
import type { AppContext } from "../context.js";
import { iso, num, one, rows, tsParam, type Tx } from "../db/client.js";
import { burns, claims, manifests, reports } from "../db/schema.js";
import { claimShort, newId } from "../lib/ids.js";
import type { BodyOf, Schemas } from "../lib/openapi.js";
import { Problem, type FieldError } from "../lib/problem.js";
import type { Principal } from "./auth.js";
import { evaluateReport } from "./ci.js";
import { appendEvent } from "./events.js";
import { getInstance } from "./instance.js";
import { DEPS_MERGED } from "./ledger.js";
import { notifyTotals } from "./stream.js";
import { REPORT_VIEW, reportById, taskByPk, toReport, type ReportViewRow } from "./tasks.js";

type ClaimRow = typeof claims.$inferSelect;

const utcDayStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function claimTask(ctx: AppContext, who: Principal, taskRef: string): Promise<Schemas["Claim"]> {
  const sep = taskRef.indexOf(":");
  const slug = taskRef.slice(0, sep);
  const manifestId = taskRef.slice(sep + 1);
  const now = ctx.clock.now();

  const result = await ctx.db.transaction(async (tx) => {
    const target = await one<{ id: string; project_id: string; status: string; repo_url: string }>(
      tx,
      sql`SELECT m.id, m.project_id, p.status, p.repo_url FROM manifests m JOIN projects p ON p.id = m.project_id
          WHERE p.slug = ${slug} AND m.manifest_id = ${manifestId}`,
    );
    if (!target || target.status === "removed") throw new Problem("not-found", `No task ${taskRef}.`);
    if (target.status !== "active") throw new Problem("project-not-active", `Project ${slug} is ${target.status}.`);
    const projectId = Number(target.project_id);

    // Serialise this donor's claims (claim limit) and this project's grants (daily cap).
    // Both waits are bounded by other short claim transactions; the task row itself is never waited on.
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${who.user.id} FOR NO KEY UPDATE`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(4711, ${projectId})`);

    // The queue primitive: lock the task row or walk away. Exactly one concurrent caller gets it.
    const m = await one<{ id: string; state: string; max_tokens: string; commit: string; content_hash: string; deps_ok: boolean }>(
      tx,
      sql`SELECT m.id, m.state, m.max_tokens, m.commit, m.content_hash, ${DEPS_MERGED} AS deps_ok
          FROM manifests m WHERE m.id = ${Number(target.id)} FOR UPDATE OF m SKIP LOCKED`,
    );
    if (!m || m.state !== "open") throw new Problem("task-not-open", `Task ${taskRef} is not open.`);
    if (!m.deps_ok) throw new Problem("dependencies-unmet", `Task ${taskRef} has dependencies that are not merged yet.`);

    const instance = await getInstance(tx);
    const active = await one<{ n: string }>(tx, sql`SELECT count(*)::text AS n FROM claims WHERE user_id = ${who.user.id} AND status = 'active' AND lease_expires_at > ${tsParam(now)}`);
    if (num(active?.n) >= instance.maxActiveClaimsPerDonor) {
      throw new Problem("claim-limit", `You already hold ${instance.maxActiveClaimsPerDonor} active claim(s), the maximum on this instance.`);
    }

    const merged = await one<{ n: string }>(tx, sql`SELECT count(*)::text AS n FROM manifests WHERE project_id = ${projectId} AND state = 'merged'`);
    if (num(merged?.n) < instance.establishedAfterMergedTasks) {
      const maxTokens = num(m.max_tokens);
      if (maxTokens > instance.newProjectMaxTokensPerTask) {
        throw new Problem("project-task-cap", `This task's max_tokens (${maxTokens}) exceeds the cap for new projects (${instance.newProjectMaxTokensPerTask}).`);
      }
      const granted = await one<{ n: string }>(
        tx,
        sql`SELECT coalesce(sum(max_tokens), 0)::text AS n FROM claims WHERE project_id = ${projectId} AND claimed_at >= ${tsParam(utcDayStart(now))}`,
      );
      if (num(granted?.n) >= instance.newProjectMaxTokensPerDay) {
        throw new Problem("project-daily-cap", `This new project has reached its daily cap of ${instance.newProjectMaxTokensPerDay} granted tokens.`);
      }
    }

    const publicId = newId("clm");
    const leaseExpiresAt = new Date(now.getTime() + instance.leaseSeconds * 1000);
    const manifestPk = Number(m.id);
    await tx.insert(claims).values({
      publicId,
      manifestId: manifestPk,
      projectId,
      userId: who.user.id,
      apiKeyId: who.apiKeyId ?? null,
      status: "active",
      commit: m.commit,
      contentHash: m.content_hash,
      maxTokens: num(m.max_tokens),
      leaseSeconds: instance.leaseSeconds,
      claimedAt: now,
      leaseExpiresAt,
    });
    await tx.update(manifests).set({ state: "claimed", updatedAt: now }).where(eq(manifests.id, manifestPk));
    await appendEvent(ctx, tx, {
      actor: who.user.handle,
      action: "task.claimed",
      projectId,
      project: slug,
      taskId: taskRef,
      payload: { claim_id: publicId, commit: m.commit, content_hash: m.content_hash, lease_expires_at: leaseExpiresAt.toISOString() },
    });
    const task = await taskByPk(ctx, tx, manifestPk);
    const claim: Schemas["Claim"] = {
      claim_id: publicId,
      task,
      project: slug,
      repo_url: target.repo_url,
      base_branch: task.manifest.base_branch ?? "main",
      commit: m.commit,
      content_hash: m.content_hash,
      lease_expires_at: leaseExpiresAt.toISOString(),
      lease_seconds: instance.leaseSeconds,
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    };
    return claim;
  });
  return result;
}

interface OwnedClaim {
  claim: ClaimRow;
  slug: string;
  mid: string;
  manifestState: string;
}

/** Locks the claim row for the caller. 404 when unknown, 403 when it is someone else's. */
async function lockOwnClaim(tx: Tx, who: Principal, claimId: string): Promise<OwnedClaim> {
  const [claim] = await tx.select().from(claims).where(eq(claims.publicId, claimId)).for("no key update");
  if (!claim) throw new Problem("not-found", `No claim ${claimId}.`);
  if (claim.userId !== who.user.id) throw new Problem("forbidden", "This claim belongs to another donor.");
  const ref = await one<{ slug: string; mid: string; state: string }>(
    tx,
    sql`SELECT p.slug, m.manifest_id AS mid, m.state FROM manifests m JOIN projects p ON p.id = m.project_id WHERE m.id = ${claim.manifestId}`,
  );
  if (!ref) throw new Problem("not-found", `No claim ${claimId}.`);
  return { claim, slug: ref.slug, mid: ref.mid, manifestState: ref.state };
}

/** claim → expired, task → open. The caller holds the claim row lock. */
async function expireLocked(ctx: AppContext, tx: Tx, c: { id: number; publicId: string; manifestId: number; projectId: number }, slug: string, mid: string): Promise<void> {
  const now = ctx.clock.now();
  await tx.update(claims).set({ status: "expired", endedAt: now }).where(eq(claims.id, c.id));
  await tx.update(manifests).set({ state: "open", updatedAt: now }).where(and(eq(manifests.id, c.manifestId), eq(manifests.state, "claimed")));
  await appendEvent(ctx, tx, { actor: "system", action: "claim.expired", projectId: c.projectId, project: slug, taskId: `${slug}:${mid}`, payload: { claim_id: c.publicId } });
}

export async function heartbeat(ctx: AppContext, who: Principal, claimId: string, body: BodyOf<"heartbeatClaim">): Promise<{ lease_expires_at: string }> {
  const now = ctx.clock.now();
  const out = await ctx.db.transaction(async (tx) => {
    const { claim, slug, mid } = await lockOwnClaim(tx, who, claimId);
    if (claim.status !== "active") return { error: new Problem("claim-not-active", `Claim ${claimId} is ${claim.status}; stop work.`) };
    if (claim.leaseExpiresAt.getTime() <= now.getTime()) {
      await expireLocked(ctx, tx, claim, slug, mid);
      return { error: new Problem("claim-not-active", `Claim ${claimId} expired; stop work.`) };
    }
    const leaseExpiresAt = new Date(now.getTime() + claim.leaseSeconds * 1000);
    const tokensIn = body.tokens_in ?? claim.tokensIn;
    const tokensOut = body.tokens_out ?? claim.tokensOut;
    await tx
      .update(claims)
      .set({ leaseExpiresAt, lastHeartbeatAt: now, tokensIn, tokensOut, phase: body.phase ?? claim.phase })
      .where(eq(claims.id, claim.id));
    const moved = tokensIn !== claim.tokensIn || tokensOut !== claim.tokensOut;
    if (moved) await notifyTotals(tx, claim.projectId);
    return { lease: leaseExpiresAt };
  });
  if (out.error) throw out.error;
  return { lease_expires_at: out.lease!.toISOString() };
}

function completedProblems(body: BodyOf<"reportClaim">, expectedBranch: string): FieldError[] {
  const errors: FieldError[] = [];
  if (!body.branch) errors.push({ path: "/branch", message: "is required when status is completed" });
  else if (body.branch !== expectedBranch) errors.push({ path: "/branch", message: `must be ${expectedBranch}` });
  if (!body.pr_url) errors.push({ path: "/pr_url", message: "is required when status is completed" });
  else if (!/^https?:\/\/\S+$/.test(body.pr_url)) errors.push({ path: "/pr_url", message: "must be an http(s) URL" });
  if (!body.head_sha) errors.push({ path: "/head_sha", message: "is required when status is completed" });
  if (body.verify_exit_code !== 0) errors.push({ path: "/verify_exit_code", message: "must be 0 when status is completed" });
  return errors;
}

export async function report(ctx: AppContext, who: Principal, claimId: string, body: BodyOf<"reportClaim">): Promise<Schemas["Report"]> {
  const now = ctx.clock.now();
  const out = await ctx.db.transaction(async (tx) => {
    const { claim, slug, mid } = await lockOwnClaim(tx, who, claimId);
    const taskRef = `${slug}:${mid}`;
    const existing = await one<{ id: string }>(tx, sql`SELECT id FROM reports WHERE claim_id = ${claim.id}`);
    if (existing || claim.status === "reported") throw new Problem("already-reported", `Claim ${claimId} already has a report.`);
    if (claim.status === "released") throw new Problem("claim-not-active", `Claim ${claimId} was released.`);
    if (body.status === "completed") {
      const errors = completedProblems(body, `agentfund/${mid}-${claimShort(claim.publicId)}`);
      if (errors.length) throw new Problem("validation", "A completed report needs branch, pr_url, head_sha and verify_exit_code 0.", { errors });
    }

    const late = claim.status === "expired";
    if (claim.status === "active" && claim.leaseExpiresAt.getTime() <= now.getTime()) {
      // The lease ran out before the sweeper got here; the report is late all the same.
      return { expire: { claim, slug, mid } } as const;
    }
    const completed = body.status === "completed" && !late;
    const publicId = newId("rep");
    const [row] = await tx
      .insert(reports)
      .values({
        publicId,
        claimId: claim.id,
        projectId: claim.projectId,
        manifestId: claim.manifestId,
        userId: claim.userId,
        status: body.status,
        tokensIn: body.tokens_in,
        tokensOut: body.tokens_out,
        costEstimate: body.cost_estimate,
        branch: body.branch ?? null,
        prUrl: body.pr_url ?? null,
        headSha: body.head_sha ?? null,
        verifyExitCode: body.verify_exit_code ?? null,
        logDigest: body.log_digest,
        durationSeconds: body.duration_seconds ?? null,
        runner: body.runner ?? null,
        model: body.model ?? null,
        message: body.message ?? null,
        flaggedLate: late,
        delivery: completed ? "pending_ci" : "none",
        createdAt: now,
      })
      .returning({ id: reports.id });
    if (!row) throw new Problem("internal", "report insert failed");
    const tokens = body.tokens_in + body.tokens_out;

    if (late) {
      await appendEvent(ctx, tx, { actor: who.user.handle, action: "report.late", projectId: claim.projectId, project: slug, taskId: taskRef, payload: { report_id: publicId, claim_id: claimId, status: body.status, tokens } });
      return { reportId: row.id } as const;
    }

    await tx.update(claims).set({ status: "reported", endedAt: now }).where(eq(claims.id, claim.id));
    await appendEvent(ctx, tx, {
      actor: who.user.handle,
      action: "report.received",
      projectId: claim.projectId,
      project: slug,
      taskId: taskRef,
      payload: { report_id: publicId, claim_id: claimId, status: body.status, tokens, branch: body.branch ?? null, pr_url: body.pr_url ?? null, head_sha: body.head_sha ?? null },
    });
    if (!completed) {
      const reopened = await tx.update(manifests).set({ state: "open", updatedAt: now }).where(and(eq(manifests.id, claim.manifestId), eq(manifests.state, "claimed"))).returning({ id: manifests.id });
      if (reopened.length) await appendEvent(ctx, tx, { actor: "system", action: "task.reopened", projectId: claim.projectId, project: slug, taskId: taskRef, payload: { reason: `report:${body.status}`, report_id: publicId } });
    } else {
      // CI may have finished before the report arrived; evidence already on file counts.
      await evaluateReport(ctx, tx, row.id);
    }
    return { reportId: row.id } as const;
  });

  if ("expire" in out && out.expire) {
    await ctx.db.transaction(async (tx) => {
      const [c] = await tx.select().from(claims).where(eq(claims.id, out.expire.claim.id)).for("no key update");
      if (c && c.status === "active") await expireLocked(ctx, tx, c, out.expire.slug, out.expire.mid);
    });
    return report(ctx, who, claimId, body);
  }
  return reportById(ctx, ctx.db, out.reportId);
}

export async function release(ctx: AppContext, who: Principal, claimId: string, body: BodyOf<"releaseClaim">): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.transaction(async (tx) => {
    const { claim, slug, mid } = await lockOwnClaim(tx, who, claimId);
    if (claim.status !== "active") throw new Problem("claim-not-active", `Claim ${claimId} is ${claim.status}.`);
    const taskRef = `${slug}:${mid}`;
    const tokensIn = body.tokens_in ?? 0;
    const tokensOut = body.tokens_out ?? 0;
    await tx.update(claims).set({ status: "released", endedAt: now }).where(eq(claims.id, claim.id));
    if (tokensIn + tokensOut > 0) {
      await tx.insert(burns).values({ claimId: claim.id, projectId: claim.projectId, manifestId: claim.manifestId, userId: claim.userId, tokensIn, tokensOut, reason: body.reason ?? null, createdAt: now });
    }
    await tx.update(manifests).set({ state: "open", updatedAt: now }).where(and(eq(manifests.id, claim.manifestId), eq(manifests.state, "claimed")));
    await appendEvent(ctx, tx, { actor: who.user.handle, action: "claim.released", projectId: claim.projectId, project: slug, taskId: taskRef, payload: { claim_id: claimId, reason: body.reason ?? null, tokens: tokensIn + tokensOut } });
  });
}

/** Expires every lease that has run out. Safe to run from several replicas at once. */
export async function sweepLeases(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  return ctx.db.transaction(async (tx) => {
    const due = await rows<{ id: string; public_id: string; manifest_id: string; project_id: string; slug: string; mid: string }>(
      tx,
      sql`SELECT c.id, c.public_id, c.manifest_id, c.project_id, p.slug, m.manifest_id AS mid
          FROM claims c JOIN manifests m ON m.id = c.manifest_id JOIN projects p ON p.id = c.project_id
          WHERE c.status = 'active' AND c.lease_expires_at <= ${tsParam(now)}
          ORDER BY c.id LIMIT 500 FOR NO KEY UPDATE OF c SKIP LOCKED`,
    );
    for (const c of due) {
      await expireLocked(ctx, tx, { id: Number(c.id), publicId: c.public_id, manifestId: Number(c.manifest_id), projectId: Number(c.project_id) }, c.slug, c.mid);
    }
    return due.length;
  });
}

export async function myClaims(ctx: AppContext, who: Principal, opts: { active?: boolean; limit: number }): Promise<Schemas["ClaimSummary"][]> {
  const filter = opts.active === undefined ? sql`` : opts.active ? sql`AND c.status = 'active'` : sql`AND c.status <> 'active'`;
  const list = await rows<{ id: string; public_id: string; status: Schemas["ClaimSummary"]["status"]; claimed_at: string; lease_expires_at: string; slug: string; mid: string }>(
    ctx.db,
    sql`SELECT c.id, c.public_id, c.status, c.claimed_at, c.lease_expires_at, p.slug, m.manifest_id AS mid
        FROM claims c JOIN manifests m ON m.id = c.manifest_id JOIN projects p ON p.id = c.project_id
        WHERE c.user_id = ${who.user.id} ${filter} ORDER BY c.id DESC LIMIT ${opts.limit}`,
  );
  const byClaim = new Map<string, Schemas["Report"]>();
  if (list.length) {
    const reps = await rows<ReportViewRow & { claim_id: string }>(ctx.db, sql`${REPORT_VIEW} WHERE r.claim_id IN (${sql.join(list.map((c) => sql`${Number(c.id)}`), sql`, `)})`);
    for (const r of reps) byClaim.set(String(r.claim_id), toReport(ctx, r));
  }
  return list.map((c) => ({
    claim_id: c.public_id,
    task_id: `${c.slug}:${c.mid}`,
    project: c.slug,
    status: c.status,
    claimed_at: iso(c.claimed_at),
    lease_expires_at: iso(c.lease_expires_at),
    report: byClaim.get(String(c.id)) ?? null,
  }));
}

export async function createPledge(ctx: AppContext, who: Principal, project: { id: number; slug: string; status: string }, amount: number): Promise<Schemas["Pledge"]> {
  if (project.status !== "active") throw new Problem("project-not-active", `Project ${project.slug} is ${project.status}.`);
  const now = ctx.clock.now();
  const publicId = newId("plg");
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO pledges (public_id, project_id, user_id, token_amount, created_at) VALUES (${publicId}, ${project.id}, ${who.user.id}, ${amount}, ${tsParam(now)})`);
    await appendEvent(ctx, tx, { actor: who.user.handle, action: "pledge.created", projectId: project.id, project: project.slug, payload: { pledge_id: publicId, token_amount: amount } });
  });
  return {
    id: publicId,
    project: project.slug,
    donor: { id: `${ctx.config.baseUrl}/u/${who.user.handle}`, handle: who.user.handle, avatar_url: who.user.avatarUrl },
    token_amount: amount,
    created_at: now.toISOString(),
  };
}
