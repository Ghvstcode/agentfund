import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Database, Db } from "./db/client.js";
import type { Git } from "./lib/git.js";
import type { OpenApiSpec } from "./lib/openapi.js";
import type { Logger } from "./log.js";
import type { StreamHub } from "./services/stream.js";

/** Everything a service needs; built once in `createContext` and passed explicitly. */
export interface AppContext {
  config: Config;
  database: Database;
  db: Db;
  clock: Clock;
  log: Logger;
  git: Git;
  spec: OpenApiSpec;
  hub: StreamHub;
  /** Outbound HTTP (GitHub OAuth + REST). Injectable so tests run on fixtures. */
  fetch: typeof fetch;
}
