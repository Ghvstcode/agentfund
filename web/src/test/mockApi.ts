import { vi } from 'vitest';

type Handler = (request: Request) => unknown | Promise<unknown>;

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Wrap a body with a non-200 status. */
export function reply(status: number, body: unknown): MockResponse {
  return { status, body };
}

function isMockResponse(value: unknown): value is MockResponse {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

/**
 * Replace global fetch with a router keyed by "METHOD /path". Unknown routes answer 404 with a
 * problem document. Returns the spy so tests can assert on the requests made.
 */
export function mockApi(routes: Record<string, Handler>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = routes[key];
    const result = handler
      ? await handler(request)
      : reply(404, { type: 'http://api.test/problems/not-found', title: `No mock for ${key}`, status: 404 });
    const { status, body } = isMockResponse(result) ? result : { status: 200, body: result };
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

export const META = {
  app: 'AgentFund',
  name: 'Test Instance',
  version: '1.2.3',
  base_url: 'https://fund.example',
  protocol_versions: ['v1'],
  spec_versions: [1],
  capabilities: { github_oauth: true, dev_login: true, sse: true, ci_providers: ['github'], ci_poll: false, federation: false },
};
