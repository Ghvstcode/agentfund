/** Routing glue: every /v1 route is registered by operationId and validated against the OpenAPI document. */
import type { Context, Hono } from "hono";
import type { AppContext } from "../context.js";
import { formatErrors, type BodyOf, type Operation, type OperationId, type PathOf, type QueryOf } from "../lib/openapi.js";
import { Problem } from "../lib/problem.js";
import { authenticate, type Principal } from "../services/auth.js";
import { membersOnly, OPEN_OPERATIONS, requireMember } from "../services/members.js";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface Req<K extends OperationId> {
  c: Context;
  path: PathOf<K>;
  query: QueryOf<K>;
  /** Raw query string values, before defaults — to tell "omitted" from "default". */
  given: URLSearchParams;
  body: BodyOf<K>;
  /** Exact request bytes (webhook signatures are computed over these). */
  raw: Uint8Array;
  /** Authenticated caller; null only on public operations. */
  auth: Principal | null;
  /** The caller, for operations that require one. */
  who: Principal;
}

export type Handler<K extends OperationId> = (req: Req<K>) => Promise<Response> | Response;

export function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

async function resolveAuth(ctx: AppContext, c: Context, op: Operation): Promise<Principal | null> {
  const schemes = op.schemes.filter((s) => s !== "webhookSignature");
  const token = bearer(c);
  if (membersOnly(ctx) && !OPEN_OPERATIONS.has(op.id)) return resolveMember(ctx, token, schemes, op);
  if (schemes.length === 0) {
    // Public operation: a valid credential personalises the answer, a bad one is ignored.
    if (!token) return null;
    const p = await authenticate(ctx, token).catch(() => null);
    return p && !p.user.banned ? p : null;
  }
  if (!token) throw new Problem("unauthorized", "Send `Authorization: Bearer <token>`.", { headers: { "www-authenticate": "Bearer" } });
  const principal = await authenticate(ctx, token);
  if (!principal) throw new Problem("unauthorized", "The token is invalid, expired or revoked.", { headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
  if (principal.user.banned) throw new Problem("banned", "This account is banned on this instance.");
  if (!schemes.includes(principal.kind)) {
    throw new Problem("unauthorized", principal.kind === "donorKey" ? "This operation needs a session token (afs_…), not an API key." : "This operation needs a worker API key (af_…), not a session token.");
  }
  if (op.tags.includes("admin") && principal.user.role !== "admin") throw new Problem("forbidden", "Admin role required.");
  return principal;
}

/** Members-only instances: every operation outside OPEN_OPERATIONS needs a member's credential. */
async function resolveMember(ctx: AppContext, token: string | null, schemes: string[], op: Operation): Promise<Principal> {
  if (!token) throw new Problem("unauthorized", "This instance is for members only; sign in first.", { headers: { "www-authenticate": "Bearer" } });
  const principal = await authenticate(ctx, token);
  if (!principal) throw new Problem("unauthorized", "The token is invalid, expired or revoked.", { headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
  if (principal.user.banned) throw new Problem("banned", "This account is banned on this instance.");
  await requireMember(ctx, principal.user);
  if (schemes.length > 0 && !schemes.includes(principal.kind)) {
    throw new Problem("unauthorized", principal.kind === "donorKey" ? "This operation needs a session token (afs_…), not an API key." : "This operation needs a worker API key (af_…), not a session token.");
  }
  if (op.tags.includes("admin") && principal.user.role !== "admin") throw new Problem("forbidden", "Admin role required.");
  return principal;
}

async function readBody(c: Context): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new Problem("validation", "Request body is too large.", { status: 413 });
  const buf = new Uint8Array(await c.req.raw.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) throw new Problem("validation", "Request body is too large.", { status: 413 });
  return buf;
}

export function registrar(app: Hono, ctx: AppContext) {
  const registered = new Set<OperationId>();
  function op<K extends OperationId>(id: K, handler: Handler<K>, opts: { rawBody?: boolean } = {}): void {
    const operation = ctx.spec.operation(id);
    registered.add(id);
    app.on(operation.method.toUpperCase(), operation.route, async (c) => {
      const auth = await resolveAuth(ctx, c, operation);

      const path: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.req.param() as Record<string, string>)) path[k] = v;
      if (operation.validatePath && !operation.validatePath(path)) {
        // A path that does not match the documented pattern cannot name anything that exists.
        throw new Problem("not-found", "No such resource.");
      }
      const given = new URL(c.req.url).searchParams;
      const query: Record<string, unknown> = {};
      for (const [k, v] of given) if (!(k in query)) query[k] = v;
      if (operation.validateQuery && !operation.validateQuery(query)) {
        throw new Problem("validation", "Invalid query parameters.", { errors: formatErrors(operation.validateQuery.errors) });
      }

      let raw: Uint8Array = new Uint8Array();
      let body: unknown = undefined;
      if (operation.hasBody) {
        raw = await readBody(c);
        if (!opts.rawBody) {
          const text = new TextDecoder().decode(raw).trim();
          if (text === "") {
            if (operation.bodyRequired) throw new Problem("validation", "A JSON body is required.", { errors: [{ path: "/", message: "body is required" }] });
            body = {};
          } else {
            try {
              body = JSON.parse(text);
            } catch {
              throw new Problem("validation", "The body is not valid JSON.", { errors: [{ path: "/", message: "invalid JSON" }] });
            }
          }
          if (operation.validateBody && !operation.validateBody(body)) {
            throw new Problem("validation", "The request body does not match the schema.", { errors: formatErrors(operation.validateBody.errors) });
          }
        }
      }
      const req = {
        c,
        path,
        query,
        given,
        body,
        raw,
        auth,
        get who(): Principal {
          if (!auth) throw new Problem("unauthorized", "Authentication required.");
          return auth;
        },
      } as unknown as Req<K>;
      return handler(req);
    });
  }
  return { op, registered };
}

export function json<T>(c: Context, status: 200 | 201 | 202, body: T): Response {
  return c.json(body as never, status);
}

export const noContent = (c: Context): Response => c.body(null, 204);
