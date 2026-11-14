import { serve } from "@hono/node-server";
import { createContext } from "./bootstrap.js";
import { pollOnce } from "./ci/poller.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { APP_NAME, VERSION } from "./constants.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./log.js";
import { sweepLeases } from "./services/claims.js";
import { syncAll as syncPeers } from "./services/federation.js";
import { indexAll } from "./services/indexer.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exit(1);
}
const log = createLogger(config.logLevel);
for (const w of config.warnings) log.warn(w);

const runtime = await createContext(config, { log }).catch((err: unknown) => {
  log.error("startup failed", { err });
  process.exit(1);
});
const { ctx } = runtime;
if (config.webhookSecret) log.info("WEBHOOK_SECRET is set: the instance-wide webhook secret is accepted for every project, next to each project's own secret.");

const app = createApp(ctx);
const server = serve({ fetch: app.hono.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  log.info(`${APP_NAME} listening`, { port: info.port, base_url: config.baseUrl, version: VERSION, dev_login: config.authDevLogin, ci_poll: config.ciPoll });
});

/** Runs `fn` every `seconds`, never overlapping itself, until stopped. */
function every(name: string, seconds: number, fn: () => Promise<unknown>): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      await fn();
    } catch (err) {
      log.error(`${name} failed`, { err });
    }
    if (!stopped) timer = setTimeout(() => void tick(), seconds * 1000);
  };
  timer = setTimeout(() => void tick(), Math.min(seconds, 5) * 1000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

const stops = [every("lease sweeper", config.sweepIntervalSeconds, () => sweepLeases(ctx))];
if (config.indexIntervalSeconds > 0) stops.push(every("indexer", config.indexIntervalSeconds, () => indexAll(ctx)));
if (config.federation && config.federationSyncIntervalSeconds > 0) stops.push(every("federation sync", config.federationSyncIntervalSeconds, () => syncPeers(ctx)));
if (config.ciPoll) stops.push(every("ci poller", config.ciPollIntervalSeconds, () => pollOnce(ctx)));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info("shutting down", { signal });
  for (const stop of stops) stop();
  const force = setTimeout(() => {
    log.warn("forcing exit after timeout");
    process.exit(1);
  }, 10_000);
  force.unref();
  // End the streams first so server.close() is not held open by SSE sockets, let in-flight
  // requests finish, then drop the database pool.
  await ctx.hub.stop().catch(() => undefined);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  });
  await runtime.close().catch((err: unknown) => log.error("close failed", { err }));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
