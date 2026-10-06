import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import type { AppContext } from "../context.js";
import { Problem } from "../lib/problem.js";
import { bearer } from "./kit.js";

export function problemResponse(ctx: AppContext, c: Context, p: Problem): Response {
  return new Response(JSON.stringify(p.toJSON(ctx.config.baseUrl, new URL(c.req.url).pathname)), {
    status: p.status,
    headers: { "content-type": "application/problem+json", "cache-control": "no-store", ...p.headers },
  });
}

export function clientIp(ctx: AppContext, c: Context): string {
  if (ctx.config.trustProxy) {
    const fwd = c.req.header("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "local";
}

/**
 * CORS. Tokens are bearer headers, never cookies, so the policy is about who may send
 * `Authorization` from a browser: the instance's own origin and WEB_ORIGINS. Anonymous GETs
 * are readable from anywhere.
 */
export function cors(ctx: AppContext): MiddlewareHandler {
  const allowed = new Set([new URL(ctx.config.baseUrl).origin, ...ctx.config.webOrigins]);
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    const trusted = allowed.has(origin);
    if (c.req.method === "OPTIONS" && c.req.header("access-control-request-method")) {
      const headers: Record<string, string> = { vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers", "access-control-max-age": "600" };
      if (trusted) {
        headers["access-control-allow-origin"] = origin;
        headers["access-control-allow-methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
        headers["access-control-allow-headers"] = "Authorization, Content-Type";
      } else {
        headers["access-control-allow-origin"] = "*";
        headers["access-control-allow-methods"] = "GET";
        headers["access-control-allow-headers"] = "Content-Type";
      }
      return new Response(null, { status: 204, headers });
    }
    await next();
    c.res.headers.append("vary", "Origin");
    if (trusted) {
      c.res.headers.set("access-control-allow-origin", origin);
      c.res.headers.set("access-control-expose-headers", "Retry-After");
    } else if ((c.req.method === "GET" || c.req.method === "HEAD") && !c.req.header("authorization")) {
      c.res.headers.set("access-control-allow-origin", "*");
    }
  };
}

interface Window {
  start: number;
  count: number;
}

/** Fixed one-minute windows per client IP and, separately, per presented credential. Per replica. */
export function rateLimit(ctx: AppContext): MiddlewareHandler {
  const windows = new Map<string, Window>();
  const hit = (key: string, limit: number, now: number): number | null => {
    if (limit <= 0) return null;
    let w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      windows.set(key, w);
    }
    w.count++;
    return w.count > limit ? Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000)) : null;
  };
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith("/v1/") || c.req.method === "OPTIONS") return next();
    const now = Date.now();
    if (windows.size > 50_000) for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
    const ip = clientIp(ctx, c);
    const token = bearer(c);
    const retry =
      (path.startsWith("/v1/auth/") ? hit(`auth:${ip}`, ctx.config.authRateLimitPerMinute, now) : null) ??
      hit(`ip:${ip}`, ctx.config.rateLimitPerMinute, now) ??
      (token ? hit(`tok:${createHash("sha256").update(token).digest("hex").slice(0, 24)}`, ctx.config.rateLimitPerMinute, now) : null);
    if (retry !== null) return problemResponse(ctx, c, new Problem("rate-limited", "Too many requests; slow down.", { headers: { "retry-after": String(retry) } }));
    return next();
  };
}

export function requestLog(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    await next();
    const url = new URL(c.req.url);
    if (url.pathname === "/healthz") return;
    // The query string is not logged: OAuth callbacks carry codes there.
    ctx.log.info("request", { method: c.req.method, path: url.pathname, status: c.res.status, ms: Date.now() - started });
  };
}
