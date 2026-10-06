import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./paths.js";

/** Software name. The single place the product name lives; override the display name with APP_NAME. */
export const APP_NAME = process.env.APP_NAME?.trim() || "AgentFund";

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const PROTOCOL_VERSIONS = ["v1"];
export const SPEC_VERSIONS = [1];
export const HEARTBEAT_INTERVAL_SECONDS = 60;
export const DEFAULT_PORT = 8787;

/** Slugs that would shadow server or SPA routes; a project cannot take them. */
export const RESERVED_SLUGS = new Set([
  "v1", "v2", "u", "og", "api", "assets", "static", "problems", "healthz", "admin", "login", "logout", "auth",
  "new", "settings", "donors", "projects", "docs", "about", "explore", "search", "me", "account", "feed",
  "sitemap", "robots", "favicon", "maintain", "styleguide", "well-known", "events", "stats", "leaderboard", "keys", "dashboard",
]);
