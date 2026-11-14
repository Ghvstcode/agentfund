/** An in-process "internet" for federation tests: instances reach each other by host name. */
import type { TestApp } from "./app.js";

export type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

export interface TestNetwork {
  fetch: typeof fetch;
  /** Routes requests for `host` to a test instance. */
  add(host: string, app: TestApp): void;
  /** Routes requests for `host` to a hand-written peer (for hostile or broken ones). */
  handle(host: string, handler: Handler): void;
  remove(host: string): void;
}

export function testNetwork(fallback?: typeof fetch): TestNetwork {
  const hosts = new Map<string, Handler>();
  return {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const handler = hosts.get(url.host);
      if (handler) return handler(url, init);
      if (fallback) return fallback(input, init);
      throw new TypeError(`fetch failed: no route to ${url.host}`);
    },
    add: (host, app) => void hosts.set(host, (url, init) => app.app.hono.request(url.toString(), init)),
    handle: (host, handler) => void hosts.set(host, handler),
    remove: (host) => void hosts.delete(host),
  };
}

export interface RawResult<T = unknown> {
  status: number;
  body: T;
  code: string | null;
}

/** A request to an instance whose base URL is not the `call` helper's http://af.test. */
export async function raw<T = unknown>(app: TestApp, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<RawResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.app.hono.request(`${app.config.baseUrl}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = res.status === 204 ? "" : await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  const code = res.status >= 400 && body && typeof body === "object" ? (String((body as { type?: string }).type ?? "").split("/").pop() ?? null) : null;
  return { status: res.status, body: body as T, code };
}
