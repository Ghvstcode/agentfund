import createClient, { type Middleware } from 'openapi-fetch';
import { API_BASE } from '../config';
import { session } from '../lib/session';
import type { paths } from './schema';
import type { Problem } from './types';

/** A non-2xx API response, carrying the RFC 9457 problem document when there was one. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;

  constructor(status: number, problem: Problem | null) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  /** Stable machine-readable code: the last path segment of the problem `type`. */
  get code(): string | null {
    return this.problem?.type.split('/').pop() ?? null;
  }
}

function isProblem(value: unknown): value is Problem {
  return typeof value === 'object' && value !== null && 'title' in value && 'status' in value;
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = session.getToken();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  },
  onResponse({ response }) {
    // The server no longer accepts this session: forget it so the UI shows signed-out state.
    if (response.status === 401) session.clear();
    return response;
  },
};

export function createApi(baseUrl: string) {
  // Look `fetch` up per request rather than capturing it once, so it can be replaced.
  const client = createClient<paths>({ baseUrl, fetch: (request) => globalThis.fetch(request) });
  client.use(auth);
  return client;
}

export const api = createApi(API_BASE);

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Turn an openapi-fetch result into data or a thrown ApiError. */
export async function unwrap<T>(request: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) throw new ApiError(response.status, isProblem(error) ? error : null);
  return data as T;
}
