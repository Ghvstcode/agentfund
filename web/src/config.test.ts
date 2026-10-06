import { describe, expect, it } from 'vitest';
import { resolveApiBase } from './config';

describe('resolveApiBase', () => {
  it('uses the build-time variable when there is no runtime override', () => {
    expect(resolveApiBase(undefined, { VITE_API_BASE_URL: 'https://api.example' })).toBe('https://api.example');
  });

  it('prefers the runtime override injected by the server', () => {
    expect(resolveApiBase({ apiBase: 'https://runtime.example' }, { VITE_API_BASE_URL: 'https://build.example' })).toBe(
      'https://runtime.example',
    );
  });

  it('treats an empty runtime override as "same origin", not as missing', () => {
    expect(resolveApiBase({ apiBase: '' }, { VITE_API_BASE_URL: 'https://build.example' })).toBe('');
  });

  it('falls back to same origin when nothing is configured', () => {
    expect(resolveApiBase(undefined, {})).toBe('');
    expect(resolveApiBase({}, {})).toBe('');
  });

  it('strips trailing slashes and whitespace so paths join cleanly', () => {
    expect(resolveApiBase(undefined, { VITE_API_BASE_URL: ' https://api.example/// ' })).toBe('https://api.example');
    expect(resolveApiBase({ apiBase: 'https://api.example/prefix/' }, {})).toBe('https://api.example/prefix');
  });
});
