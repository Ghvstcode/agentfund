import { beforeEach, describe, expect, it } from 'vitest';
import { session } from '../lib/session';
import { mockApi, reply } from '../test/mockApi';
import { api, ApiError, createApi, unwrap } from './client';

describe('API client', () => {
  beforeEach(() => session.clear());

  it('sends requests to the configured base URL', async () => {
    const fetchSpy = mockApi({ 'GET /v1/stats': () => ({ projects: 3 }) });
    await unwrap(api.GET('/v1/stats'));
    expect((fetchSpy.mock.calls[0]?.[0] as Request).url).toBe('http://api.test/v1/stats');
  });

  it('honours a different base URL, including a path prefix', async () => {
    const fetchSpy = mockApi({ 'GET /fund/v1/meta': () => ({}) });
    await createApi('https://other.example/fund').GET('/v1/meta');
    expect((fetchSpy.mock.calls[0]?.[0] as Request).url).toBe('https://other.example/fund/v1/meta');
  });

  it('attaches the session token as a bearer credential', async () => {
    const fetchSpy = mockApi({ 'GET /v1/me': () => ({ handle: 'ada' }) });
    await api.GET('/v1/me');
    expect((fetchSpy.mock.calls[0]?.[0] as Request).headers.get('authorization')).toBeNull();

    session.setToken('afs_secret');
    await api.GET('/v1/me');
    expect((fetchSpy.mock.calls[1]?.[0] as Request).headers.get('authorization')).toBe('Bearer afs_secret');
  });

  it('clears the session on 401', async () => {
    mockApi({ 'GET /v1/me': () => reply(401, { type: 'http://api.test/problems/unauthorized', title: 'Sign in required', status: 401 }) });
    session.setToken('afs_expired');
    await expect(unwrap(api.GET('/v1/me'))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(session.getToken()).toBeNull();
  });

  it('keeps the session on other errors', async () => {
    mockApi({ 'GET /v1/me': () => reply(403, { type: 'http://api.test/problems/forbidden', title: 'Forbidden', status: 403 }) });
    session.setToken('afs_valid');
    await expect(unwrap(api.GET('/v1/me'))).rejects.toBeInstanceOf(ApiError);
    expect(session.getToken()).toBe('afs_valid');
  });

  it('turns a problem document into an ApiError with its code and detail', async () => {
    mockApi({
      'GET /v1/projects/{slug}': () => undefined,
      'GET /v1/projects/missing': () =>
        reply(404, { type: 'http://api.test/problems/not-found', title: 'No such project', status: 404, detail: 'There is no project "missing".' }),
    });
    const error = await unwrap(api.GET('/v1/projects/{slug}', { params: { path: { slug: 'missing' } } })).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe('not-found');
    expect(error.message).toBe('There is no project "missing".');
  });

  it('resolves to undefined for 204 responses', async () => {
    mockApi({ 'POST /v1/auth/logout': () => reply(204, null) });
    await expect(unwrap(api.POST('/v1/auth/logout'))).resolves.toBeUndefined();
  });
});
