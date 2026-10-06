import { Hono } from "hono";
import type { AppContext } from "../context.js";
import type { OperationId } from "../lib/openapi.js";
import { Problem } from "../lib/problem.js";
import { cors, problemResponse, rateLimit, requestLog } from "./middleware.js";
import { registerPages } from "./pages.js";
import { registerApi } from "./routes.js";

export interface App {
  hono: Hono;
  /** Operation ids that have a handler; the contract test compares this with the OpenAPI document. */
  operations: Set<OperationId>;
}

export function createApp(ctx: AppContext): App {
  const hono = new Hono();
  hono.use("*", requestLog(ctx));
  hono.use("*", cors(ctx));
  hono.use("*", rateLimit(ctx));

  hono.onError((err, c) => {
    if (err instanceof Problem) return problemResponse(ctx, c, err);
    ctx.log.error("unhandled error", { path: new URL(c.req.url).pathname, method: c.req.method, err });
    return problemResponse(ctx, c, new Problem("internal", "Something went wrong on our side."));
  });

  const operations = registerApi(hono, ctx);
  // Unknown API paths and methods are API errors, never the SPA shell.
  hono.all("/v1/*", (c) => problemResponse(ctx, c, new Problem("not-found", "No such endpoint.")));
  hono.all("/v1", (c) => problemResponse(ctx, c, new Problem("not-found", "No such endpoint.")));
  registerPages(hono, ctx);
  hono.notFound((c) => c.text("Not found", 404));
  return { hono, operations };
}
