import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { AppContext } from "./context.js";
import { connect, runMigrations } from "./db/client.js";
import { Git } from "./lib/git.js";
import { GithubApp } from "./lib/github-app.js";
import { loadSpec } from "./lib/openapi.js";
import { createLogger, type Logger } from "./log.js";
import { ensureInstance } from "./services/instance.js";
import { StreamHub } from "./services/stream.js";

export interface Runtime {
  ctx: AppContext;
  close(): Promise<void>;
}

/** Connects, migrates, creates the instance row on first boot and starts the NOTIFY listener. */
export async function createContext(config: Config, overrides: { clock?: Clock; log?: Logger; fetch?: typeof fetch; migrate?: boolean } = {}): Promise<Runtime> {
  const log = overrides.log ?? createLogger(config.logLevel);
  const clock = overrides.clock ?? systemClock;
  if (overrides.migrate !== false) await runMigrations(config.databaseUrl);
  const database = connect(config.databaseUrl, { max: config.dbPoolMax });
  try {
    const dataDir = resolve(config.dataDir);
    mkdirSync(resolve(dataDir, "repos"), { recursive: true });
    await ensureInstance(database.db, config, clock);
    const hub = new StreamHub(database, log);
    await hub.start();
    const outbound: typeof fetch = overrides.fetch ?? ((input, init) => fetch(input, init));
    const githubApp = config.githubApp ? new GithubApp({ ...config.githubApp, fetch: outbound, now: () => clock.now().getTime() }) : null;
    const ctx: AppContext = {
      config,
      database,
      db: database.db,
      clock,
      log,
      git: new Git({
        dataDir,
        allowFile: config.allowFileRepos,
        onError: (info) => log.warn("git command failed", info),
        ...(githubApp ? { token: (repo) => (repo.github ? githubApp.repoToken(repo.github) : Promise.resolve(null)) } : {}),
      }),
      githubApp,
      spec: loadSpec(),
      hub,
      fetch: outbound,
    };
    return {
      ctx,
      close: async () => {
        await hub.stop();
        await database.close();
      },
    };
  } catch (err) {
    await database.close().catch(() => undefined);
    throw err;
  }
}
