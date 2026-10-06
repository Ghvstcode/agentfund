import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { expect, inject } from "vitest";
import { createContext, type Runtime } from "../../src/bootstrap.js";
import { FakeClock } from "../../src/clock.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { createApp, type App } from "../../src/http/app.js";
import { randomId } from "../../src/lib/ids.js";
import type { OperationId, Schemas } from "../../src/lib/openapi.js";
import { silentLogger } from "../../src/log.js";

export const WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";

export interface CallOptions {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /** Raw body string (sent as-is); overrides `body`. */
  raw?: string;
  token?: string | null;
  headers?: Record<string, string>;
}

export interface CallResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  /** Trailing problem code for problem+json responses. */
  code: string | null;
}

export interface TestApp {
  ctx: AppContext;
  app: App;
  clock: FakeClock;
  config: Config;
  /** Every (operation, status) pair seen, for the coverage assertion in the contract test. */
  seen: Set<string>;
  /** Calls an operation by id and validates the response (status + body) against the OpenAPI document. */
  call<T = unknown>(op: OperationId, opts?: CallOptions): Promise<CallResult<T>>;
  /** Plain request for non-API routes. */
  request(path: string, init?: RequestInit): Promise<Response>;
  login(handle: string): Promise<string>;
  apiKey(sessionToken: string, label?: string): Promise<string>;
  /** Dev-login + API key in one go. */
  donor(handle: string): Promise<{ session: string; key: string; handle: string }>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  env?: Record<string, string>;
  fetch?: typeof fetch;
  start?: string;
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const adminUrl = inject("pgUrl");
  const dbName = `t_${randomId(12)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const dataDir = mkdtempSync(join(tmpdir(), "af-data-"));
  const config = loadConfig({
    DATABASE_URL: url.toString(),
    BASE_URL: "http://af.test",
    AUTH_DEV_LOGIN: "true",
    ALLOW_FILE_REPOS: "true",
    DATA_DIR: dataDir,
    WEB_DIST: join(dataDir, "no-web-dist"),
    WEBHOOK_SECRET,
    RATE_LIMIT_PER_MINUTE: "0",
    AUTH_RATE_LIMIT_PER_MINUTE: "0",
    WEB_ORIGINS: "https://ui.example",
    DB_POOL_MAX: "12",
    ...opts.env,
  });
  const clock = new FakeClock(opts.start);
  const runtime: Runtime = await createContext(config, { clock, log: silentLogger, fetch: opts.fetch });
  const app = createApp(runtime.ctx);
  const spec = runtime.ctx.spec;
  const seen = new Set<string>();

  const call = async <T>(id: OperationId, o: CallOptions = {}): Promise<CallResult<T>> => {
    const op = spec.operation(id);
    let path = op.path;
    for (const [k, v] of Object.entries(o.path ?? {})) path = path.replace(`{${k}}`, encodeURIComponent(v));
    const qs = new URLSearchParams(Object.entries(o.query ?? {}).map(([k, v]) => [k, String(v)] as [string, string])).toString();
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: string | undefined;
    if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) body = JSON.stringify(o.body);
    if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await app.hono.request(`http://af.test${path}${qs ? `?${qs}` : ""}`, { method: op.method.toUpperCase(), headers, body, redirect: "manual" });
    seen.add(`${id} ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    const isStream = contentType.startsWith("text/event-stream");
    const text = isStream || res.status === 204 || res.status === 302 ? "" : await res.text();
    const parsed: unknown = text && contentType.includes("json") ? JSON.parse(text) : text || null;

    // Contract check on every single response the suite produces.
    const documented = spec.responseValidator(id, res.status);
    if (res.status >= 400) {
      expect(contentType, `${id} ${res.status} content-type`).toContain("application/problem+json");
      const problem = spec.schema("Problem");
      expect(problem(parsed), `${id} ${res.status} problem body: ${JSON.stringify(problem.errors)}`).toBe(true);
      expect((parsed as { status: number }).status).toBe(res.status);
      expect((parsed as { type: string }).type).toMatch(/^http:\/\/af\.test\/problems\/[a-z-]+$/);
    } else {
      expect(documented.documented, `${id} answered undocumented status ${res.status}`).toBe(true);
      if (documented.validate) {
        if (documented.contentType === "text/event-stream") expect(contentType).toContain("text/event-stream");
        else expect(documented.validate(parsed), `${id} ${res.status} body does not match the OpenAPI schema: ${JSON.stringify(documented.validate.errors)}\n${text.slice(0, 600)}`).toBe(true);
      }
    }
    const code = res.status >= 400 && parsed && typeof parsed === "object" ? String((parsed as { type?: string }).type ?? "").split("/").pop() ?? null : null;
    return { status: res.status, body: (isStream ? res : parsed) as T, headers: res.headers, code };
  };

  const login = async (handle: string): Promise<string> => {
    const r = await call<{ token: string }>("authDev", { body: { handle } });
    expect(r.status).toBe(200);
    return r.body.token;
  };
  const apiKey = async (session: string, label = "worker"): Promise<string> => {
    const r = await call<Schemas["ApiKey"] & { key: string }>("createApiKey", { token: session, body: { label } });
    expect(r.status).toBe(201);
    return r.body.key;
  };

  return {
    ctx: runtime.ctx,
    app,
    clock,
    config,
    seen,
    call,
    request: (path, init) => Promise.resolve(app.hono.request(`http://af.test${path}`, init)),
    login,
    apiKey,
    donor: async (handle) => {
      const session = await login(handle);
      return { session, key: await apiKey(session), handle };
    },
    close: async () => {
      await runtime.close();
    },
  };
}
