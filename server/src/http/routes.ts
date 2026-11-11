/** The /v1 API. Handlers are thin: validate (kit), call a service, serialise. */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { genericAdapter } from "../ci/generic.js";
import { githubAdapter } from "../ci/github.js";
import { PayloadError, verifySignature, type CiAdapter } from "../ci/adapter.js";
import { APP_NAME, HEARTBEAT_INTERVAL_SECONDS, PROTOCOL_VERSIONS, SPEC_VERSIONS, VERSION } from "../constants.js";
import type { AppContext } from "../context.js";
import { formatErrors, type OperationId, type ResponseOf, type Schemas } from "../lib/openapi.js";
import { Problem } from "../lib/problem.js";
import * as auth from "../services/auth.js";
import * as claims from "../services/claims.js";
import { projectsForRepo, recordEvidence } from "../services/ci.js";
import { listEvents } from "../services/events.js";
import * as indexer from "../services/indexer.js";
import { getInstance, toInstanceConfig, updateInstance } from "../services/instance.js";
import * as ledger from "../services/ledger.js";
import * as projects from "../services/projects.js";
import { listTasks, taskByRef } from "../services/tasks.js";
import { json, noContent, registrar } from "./kit.js";

const ADAPTERS: CiAdapter[] = [githubAdapter, genericAdapter];
const PING_MS = 15_000;

export function registerApi(app: Hono, ctx: AppContext): Set<OperationId> {
  const { op, registered } = registrar(app, ctx);
  const genericSchema = ctx.spec.schema("GenericCiResult");

  /* ---- meta ---- */

  op("getMeta", async ({ c }) => {
    const instance = await getInstance(ctx.db);
    return json<ResponseOf<"getMeta", 200>>(c, 200, {
      app: APP_NAME,
      name: instance.name,
      description: instance.description,
      version: VERSION,
      base_url: ctx.config.baseUrl,
      protocol_versions: PROTOCOL_VERSIONS,
      spec_versions: SPEC_VERSIONS,
      instance_pubkey: instance.pubkey,
      capabilities: {
        github_oauth: Boolean(ctx.config.githubClientId && ctx.config.githubClientSecret),
        dev_login: ctx.config.authDevLogin,
        // EventSource cannot send a bearer token, so a members-only instance offers polling only.
        sse: ctx.config.instanceAccess !== "members",
        ci_providers: ["github", "generic"],
        ci_poll: ctx.config.ciPoll,
        federation: false,
        members_only: ctx.config.instanceAccess === "members",
      },
      links: { source_url: ctx.config.sourceUrl, install_command: ctx.config.installCommand, ...(ctx.config.docsUrl ? { docs_url: ctx.config.docsUrl } : {}) },
      defaults: { lease_seconds: instance.leaseSeconds, heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS },
    });
  });

  op("getStats", async ({ c }) => json<ResponseOf<"getStats", 200>>(c, 200, await ledger.stats(ctx)));

  /* ---- projects (public reads) ---- */

  op("listProjects", async ({ c, query, given, auth: who }) => {
    const own = Boolean(query.maintainer && who && who.user.handle === query.maintainer.toLowerCase());
    const statuses: Schemas["ProjectStatus"][] = own && !given.has("status") ? ["pending", "active", "paused", "removed"] : [query.status ?? "active"];
    return json<ResponseOf<"listProjects", 200>>(
      c,
      200,
      await projects.listProjects(ctx, {
        q: query.q,
        language: query.language,
        tag: query.tag,
        statuses,
        needsDonors: given.has("needs_donors") ? query.needs_donors : undefined,
        sort: query.sort ?? "trending",
        maintainer: query.maintainer,
        limit: query.limit ?? 50,
        cursor: query.cursor,
      }),
    );
  });

  op("getProject", async ({ c, path, auth: who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who?.user);
    return json<ResponseOf<"getProject", 200>>(c, 200, await projects.projectById(ctx, row.id));
  });

  op("listTasks", async ({ c, path, query, given, auth: who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who?.user);
    return json<ResponseOf<"listTasks", 200>>(
      c,
      200,
      await listTasks(ctx, row.id, { state: query.state, claimable: given.has("claimable") ? query.claimable : undefined, limit: query.limit ?? 50, cursor: query.cursor }),
    );
  });

  op("getTask", async ({ c, path, auth: who }) => {
    const sep = path.task_id.indexOf(":");
    const row = await projects.visibleProject(ctx, path.task_id.slice(0, sep), who?.user);
    const task = await taskByRef(ctx, row.id, path.task_id.slice(sep + 1));
    if (!task) throw new Problem("not-found", `No task ${path.task_id}.`);
    return json<ResponseOf<"getTask", 200>>(c, 200, task);
  });

  op("getLedger", async ({ c, path, query, auth: who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who?.user);
    return json<ResponseOf<"getLedger", 200>>(c, 200, await ledger.projectLedger(ctx, row, { limit: query.limit ?? 50, cursor: query.cursor }));
  });

  op("listProjectEvents", async ({ c, path, query, auth: who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who?.user);
    return json<ResponseOf<"listProjectEvents", 200>>(c, 200, await listEvents(ctx, { projectId: row.id, limit: query.limit ?? 50, cursor: query.cursor }));
  });

  op("listEvents", async ({ c, query }) => json<ResponseOf<"listEvents", 200>>(c, 200, await listEvents(ctx, { limit: query.limit ?? 50, cursor: query.cursor })));

  op("listDonors", async ({ c, query }) => json<ResponseOf<"listDonors", 200>>(c, 200, await ledger.listDonors(ctx, { limit: query.limit ?? 50, cursor: query.cursor })));

  op("getDonor", async ({ c, path }) => json<ResponseOf<"getDonor", 200>>(c, 200, await ledger.donorProfile(ctx, path.handle)));

  /* ---- maintain ---- */

  op("createProject", async ({ c, body, who }) => json<ResponseOf<"createProject", 201>>(c, 201, await indexer.createProject(ctx, who, body)));

  op("previewProject", async ({ c, body, who }) => json<ResponseOf<"previewProject", 200>>(c, 200, await indexer.previewProject(ctx, who, body.repo_url)));

  op("updateProject", async ({ c, path, body, who }) => json<ResponseOf<"updateProject", 200>>(c, 200, await projects.updateProject(ctx, who, path.slug, body)));

  op("repinProject", async ({ c, path, body, who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who.user);
    projects.requireMaintainer(row, who);
    return json<ResponseOf<"repinProject", 200>>(c, 200, await indexer.repinProject(ctx, who, row, body?.commit));
  });

  op("getProjectWebhook", async ({ c, path, who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who.user);
    projects.requireMaintainer(row, who);
    return json<ResponseOf<"getProjectWebhook", 200>>(c, 200, projects.webhookConfig(ctx, row));
  });

  op("rotateProjectWebhook", async ({ c, path, who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who.user);
    projects.requireMaintainer(row, who);
    return json<ResponseOf<"rotateProjectWebhook", 200>>(c, 200, await projects.rotateWebhookSecret(ctx, who, row));
  });

  /* ---- work ---- */

  op("createPledge", async ({ c, path, body, who }) => {
    const row = await projects.visibleProject(ctx, path.slug, who.user);
    return json<ResponseOf<"createPledge", 201>>(c, 201, await claims.createPledge(ctx, who, row, body.token_amount));
  });

  op("claimTask", async ({ c, path, who }) => json<ResponseOf<"claimTask", 201>>(c, 201, await claims.claimTask(ctx, who, path.task_id)));

  op("heartbeatClaim", async ({ c, path, body, who }) => json<ResponseOf<"heartbeatClaim", 200>>(c, 200, await claims.heartbeat(ctx, who, path.claim_id, body ?? {})));

  op("reportClaim", async ({ c, path, body, who }) => json<ResponseOf<"reportClaim", 201>>(c, 201, await claims.report(ctx, who, path.claim_id, body)));

  op("releaseClaim", async ({ c, path, body, who }) => {
    await claims.release(ctx, who, path.claim_id, body ?? {});
    return noContent(c);
  });

  op("listMyClaims", async ({ c, query, given, who }) =>
    json<ResponseOf<"listMyClaims", 200>>(c, 200, { items: await claims.myClaims(ctx, who, { active: given.has("active") ? query.active : undefined, limit: query.limit ?? 50 }) }),
  );

  /* ---- live ---- */

  op("stream", async ({ c, query, auth: who }) => {
    let projectId: number | null = null;
    if (query.project !== undefined) {
      projectId = (await projects.visibleProject(ctx, query.project, who?.user)).id;
    }
    c.header("cache-control", "no-cache, no-transform");
    c.header("x-accel-buffering", "no");
    c.header("connection", "keep-alive");
    return streamSSE(c, async (stream) => {
      let open = true;
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => (finish = resolve));
      // Frames are written in order through one chain so a slow client cannot interleave them.
      let chain: Promise<unknown> = Promise.resolve();
      const write = (event: string, data: unknown): void => {
        if (!open) return;
        chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => close());
      };
      const unsubscribe = ctx.hub.subscribe({ projectId, send: write, close: () => close() });
      const ping = setInterval(() => write("ping", {}), PING_MS);
      function close(): void {
        if (!open) return;
        open = false;
        clearInterval(ping);
        unsubscribe();
        finish();
      }
      stream.onAbort(close);
      write("totals", await ctx.hub.snapshot(projectId));
      await done;
    });
  });

  /* ---- auth ---- */

  op("authGithubStart", async ({ c, query }) => c.redirect(await auth.startGithubOauth(ctx, query.redirect), 302));

  op("authGithubCallback", async ({ c, query }) => c.redirect(await auth.finishGithubOauth(ctx, query.code, query.state), 302));

  op("authDev", async ({ c, body }) => {
    if (!ctx.config.authDevLogin) throw new Problem("not-found", "Dev login is not enabled on this instance.");
    const user = await auth.upsertUser(ctx, { handle: body.handle });
    return json<ResponseOf<"authDev", 200>>(c, 200, { token: await auth.createSession(ctx, user.id), user: auth.toMe(ctx, user) });
  });

  op("authLogout", async ({ c, who }) => {
    if (who.sessionId !== undefined) await auth.revokeSession(ctx, who.sessionId);
    return noContent(c);
  });

  op("getMe", ({ c, who }) => json<ResponseOf<"getMe", 200>>(c, 200, auth.toMe(ctx, who.user)));

  op("listApiKeys", async ({ c, who }) => json<ResponseOf<"listApiKeys", 200>>(c, 200, { items: (await auth.listApiKeys(ctx, who.user.id)).map(auth.toApiKey) }));

  op("createApiKey", async ({ c, body, who }) => {
    const { row, secret } = await auth.createApiKey(ctx, who.user.id, body.label);
    return json<ResponseOf<"createApiKey", 201>>(c, 201, { ...auth.toApiKey(row), key: secret });
  });

  op("revokeApiKey", async ({ c, path, who }) => {
    if (!(await auth.revokeApiKey(ctx, who.user.id, path.key_id))) throw new Problem("not-found", "No such API key.");
    return noContent(c);
  });

  /* ---- admin ---- */

  op("adminListUsers", async ({ c, query }) => json<ResponseOf<"adminListUsers", 200>>(c, 200, await auth.listUsers(ctx, { q: query.q, limit: query.limit ?? 50, cursor: query.cursor })));

  op("adminUpdateUser", async ({ c, path, body, who }) => json<ResponseOf<"adminUpdateUser", 200>>(c, 200, auth.toMe(ctx, await auth.updateUser(ctx, who.user, path.handle, body))));

  op("adminListProjects", async ({ c, query }) => json<ResponseOf<"adminListProjects", 200>>(c, 200, await projects.listAllProjects(ctx, { limit: query.limit ?? 50, cursor: query.cursor })));

  op("adminUpdateProject", async ({ c, path, body, who }) => json<ResponseOf<"adminUpdateProject", 200>>(c, 200, await projects.moderateProject(ctx, who, path.slug, body.status)));

  op("adminGetInstance", async ({ c }) => json<ResponseOf<"adminGetInstance", 200>>(c, 200, toInstanceConfig(await getInstance(ctx.db))));

  op("adminUpdateInstance", async ({ c, body }) => json<ResponseOf<"adminUpdateInstance", 200>>(c, 200, toInstanceConfig(await updateInstance(ctx, body))));

  /* ---- webhooks ---- */

  op(
    "ciWebhook",
    async ({ c, raw }) => {
      const headers = c.req.raw.headers;
      const adapter = ADAPTERS.find((a) => a.accepts(headers));
      const signature = adapter ? headers.get(adapter.signatureHeader) : null;
      const refuse = new Problem("bad-signature", "Missing or invalid webhook signature.");
      if (!adapter || !signature) throw refuse;

      // The body is read once, untrusted, only to learn which project it claims to be about;
      // nothing in it is acted on until the HMAC over the raw bytes verifies under that
      // project's secret (or the operator's instance-wide secret, when one is configured).
      let payload: unknown;
      let parsed = true;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        parsed = false;
      }
      const operator = ctx.config.webhookSecret !== undefined && verifySignature(ctx.config.webhookSecret, raw, signature);
      const claimed = parsed ? adapter.claimedRepo(payload) : null;
      const candidates = claimed ? await projectsForRepo(ctx, claimed) : [];
      // Every candidate is checked (no early exit) so timing does not depend on which one matched.
      const trusted = candidates.filter((p) => verifySignature(p.webhookSecret, raw, signature) || operator);
      // Unknown project and wrong secret are indistinguishable to the sender.
      if (!operator && trusted.length === 0) throw refuse;

      if (!parsed) throw new Problem("validation", "The body is not valid JSON.", { errors: [{ path: "/", message: "invalid JSON" }] });
      if (adapter.name === "generic" && !genericSchema(payload)) {
        throw new Problem("validation", "The body is not a GenericCiResult.", { errors: formatErrors(genericSchema.errors) });
      }
      let delivery;
      try {
        delivery = adapter.parse(headers, payload);
      } catch (err) {
        if (err instanceof PayloadError) throw new Problem("validation", `Unexpected ${adapter.name} payload: ${err.message}.`, { errors: [{ path: "/", message: err.message }] });
        throw err;
      }
      let matched = false;
      for (const p of trusted.filter((x) => x.ciProvider === adapter.name)) {
        if (delivery.pushedRef !== undefined) {
          if (delivery.pushedRef === `refs/heads/${p.baseBranch}`) {
            matched = true;
            // Re-index in the background; the webhook must answer quickly.
            void indexer.indexProject(ctx, p.id).catch((err) => ctx.log.error("push re-index failed", { project: p.slug, err }));
          }
          continue;
        }
        for (const ev of delivery.evidence) {
          if ((await recordEvidence(ctx, p.id, ev)).matched) matched = true;
        }
      }
      return json<ResponseOf<"ciWebhook", 202>>(c, 202, { matched });
    },
    { rawBody: true },
  );

  return registered;
}
