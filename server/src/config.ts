import { z } from "zod";
import { DEFAULT_PORT } from "./constants.js";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
      ctx.addIssue({ code: "custom", message: "must be true or false" });
      return z.NEVER;
    });

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const list = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const origin = (v: string, ctx: z.RefinementCtx): string => {
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    return u.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: `"${v}" is not an http(s) origin` });
    return z.NEVER;
  }
};

const envSchema = z.object({
  INSTANCE_NAME: optional,
  INSTANCE_DESCRIPTION: optional,
  BASE_URL: optional,
  PORT: int(DEFAULT_PORT, 1, 65535),
  DATABASE_URL: z.string({ error: "is required (postgres://user:pass@host:5432/db)" }).regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  GITHUB_TOKEN: optional,
  WEBHOOK_SECRET: optional,
  WEB_ORIGINS: list.transform((arr, ctx) => arr.map((o) => origin(o, ctx))),
  ADMIN_HANDLES: list.transform((arr) => arr.map((h) => h.toLowerCase())),
  AUTH_DEV_LOGIN: optional,
  ALLOW_FILE_REPOS: bool(false),
  CI_POLL: bool(false),
  DATA_DIR: optional,
  WEB_DIST: optional,
  INDEX_INTERVAL_SECONDS: int(60, 0, 86_400),
  SWEEP_INTERVAL_SECONDS: int(15, 1, 3600),
  CI_POLL_INTERVAL_SECONDS: int(30, 5, 3600),
  SESSION_TTL_DAYS: int(30, 1, 3650),
  RATE_LIMIT_PER_MINUTE: int(600, 0, 1_000_000),
  AUTH_RATE_LIMIT_PER_MINUTE: int(30, 0, 1_000_000),
  TRUST_PROXY: bool(false),
  DB_POOL_MAX: int(10, 1, 200),
  SOURCE_URL: optional,
  INSTALL_COMMAND: optional,
  DOCS_URL: optional,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
});

export interface Config {
  instanceName: string | undefined;
  instanceDescription: string | undefined;
  baseUrl: string;
  port: number;
  databaseUrl: string;
  githubClientId: string | undefined;
  githubClientSecret: string | undefined;
  githubToken: string | undefined;
  webhookSecret: string | undefined;
  webOrigins: string[];
  adminHandles: string[];
  authDevLogin: boolean;
  allowFileRepos: boolean;
  ciPoll: boolean;
  dataDir: string;
  webDist: string;
  indexIntervalSeconds: number;
  sweepIntervalSeconds: number;
  ciPollIntervalSeconds: number;
  sessionTtlDays: number;
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;
  trustProxy: boolean;
  dbPoolMax: number;
  logLevel: "debug" | "info" | "warn" | "error";
  sourceUrl: string;
  installCommand: string;
  docsUrl: string | undefined;
  /** Human-readable notes about defaults that were applied; logged at boot. */
  warnings: string[];
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Unset and empty mean the same thing (compose passes `VAR=` for everything it forwards).
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const warnings: string[] = [];
  const problems: string[] = [];

  let baseUrl = e.BASE_URL ?? `http://localhost:${e.PORT}`;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    if (u.search || u.hash) throw new Error("query");
    baseUrl = (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    problems.push(`  BASE_URL: "${baseUrl}" must be an http(s) URL without query or fragment`);
  }
  if (!e.BASE_URL) warnings.push(`BASE_URL is not set; using ${baseUrl}. Set it to the public URL before exposing this instance.`);

  if (Boolean(e.GITHUB_CLIENT_ID) !== Boolean(e.GITHUB_CLIENT_SECRET)) {
    problems.push("  GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET: set both or neither");
  }
  const githubOauth = Boolean(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET);

  let authDevLogin: boolean;
  if (e.AUTH_DEV_LOGIN === undefined) {
    authDevLogin = !githubOauth;
    if (authDevLogin) {
      warnings.push(
        "GitHub OAuth is NOT configured (GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET). DEV LOGIN IS ENABLED: anyone who can reach this instance can log in as any handle, including an admin. Do not expose this instance publicly; configure GitHub OAuth and set AUTH_DEV_LOGIN=false.",
      );
    }
  } else {
    const s = e.AUTH_DEV_LOGIN.toLowerCase();
    if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(s)) problems.push("  AUTH_DEV_LOGIN: must be true or false");
    authDevLogin = ["1", "true", "yes", "on"].includes(s);
    if (authDevLogin) warnings.push("AUTH_DEV_LOGIN=true: anyone who can reach this instance can log in as any handle. Never use this on a public instance.");
    if (!authDevLogin && !githubOauth) warnings.push("Neither GitHub OAuth nor dev login is enabled: nobody can log in.");
  }
  for (const [name, value] of [["SOURCE_URL", e.SOURCE_URL], ["DOCS_URL", e.DOCS_URL]] as const) {
    if (value && !/^https?:\/\/\S+$/.test(value)) problems.push(`  ${name}: must be an http(s) URL`);
  }
  if (e.WEBHOOK_SECRET && e.WEBHOOK_SECRET.length < 16) problems.push("  WEBHOOK_SECRET: must be at least 16 characters");
  if (problems.length) throw new ConfigError(`Invalid configuration:\n${problems.join("\n")}`);

  const webOrigins = [...new Set(e.WEB_ORIGINS)];
  if (webOrigins.length === 0 && authDevLogin) {
    webOrigins.push("http://localhost:5173");
    warnings.push("WEB_ORIGINS is not set; allowing http://localhost:5173 (Vite dev server) because dev login is on.");
  }

  return {
    instanceName: e.INSTANCE_NAME,
    instanceDescription: e.INSTANCE_DESCRIPTION,
    baseUrl,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    githubClientId: e.GITHUB_CLIENT_ID,
    githubClientSecret: e.GITHUB_CLIENT_SECRET,
    githubToken: e.GITHUB_TOKEN,
    webhookSecret: e.WEBHOOK_SECRET,
    webOrigins,
    adminHandles: e.ADMIN_HANDLES,
    authDevLogin,
    allowFileRepos: e.ALLOW_FILE_REPOS,
    ciPoll: e.CI_POLL,
    dataDir: e.DATA_DIR ?? "./data",
    webDist: e.WEB_DIST ?? "../web/dist",
    indexIntervalSeconds: e.INDEX_INTERVAL_SECONDS,
    sweepIntervalSeconds: e.SWEEP_INTERVAL_SECONDS,
    ciPollIntervalSeconds: e.CI_POLL_INTERVAL_SECONDS,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    authRateLimitPerMinute: e.AUTH_RATE_LIMIT_PER_MINUTE,
    trustProxy: e.TRUST_PROXY,
    dbPoolMax: e.DB_POOL_MAX,
    logLevel: e.LOG_LEVEL,
    sourceUrl: e.SOURCE_URL ?? "https://github.com/agentfund/agentfund",
    installCommand: e.INSTALL_COMMAND ?? "curl -fsSL https://raw.githubusercontent.com/agentfund/agentfund/main/scripts/install.sh | sh",
    docsUrl: e.DOCS_URL,
    warnings,
  };
}
