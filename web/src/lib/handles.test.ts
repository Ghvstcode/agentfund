import { describe, expect, it } from 'vitest';
import { federatedBackCommands, hostOf } from './commands';
import { keyFingerprint } from './fingerprint';
import { isRemoteHandle, profilePath, splitHandle } from './handles';

describe('handles', () => {
  it('treats a handle without a host as local', () => {
    expect(splitHandle('ada')).toEqual({ name: 'ada', host: null });
    expect(isRemoteHandle('ada')).toBe(false);
  });

  it('splits a remote handle at the first @, keeping a port with the host', () => {
    expect(splitHandle('alice@a.example')).toEqual({ name: 'alice', host: 'a.example' });
    expect(splitHandle('alice@a.example:8443')).toEqual({ name: 'alice', host: 'a.example:8443' });
    expect(isRemoteHandle('alice@a.example:8443')).toBe(true);
  });

  it('does not invent a host from a stray @', () => {
    expect(splitHandle('@a.example').host).toBeNull();
    expect(splitHandle('alice@').host).toBeNull();
  });

  it('keeps a remote handle in one path segment', () => {
    expect(profilePath('ada')).toBe('/u/ada');
    expect(profilePath('alice@a.example:8443')).toBe('/u/alice%40a.example%3A8443');
  });
});

describe('federated back commands', () => {
  it('signs in on the peer through this instance, then approves there', () => {
    const lines = federatedBackCommands(
      { base_url: 'https://fund.example/' },
      { slug: 'fjord-db', instance: { base_url: 'https://fund.nordic-oss.example', host: 'fund.nordic-oss.example', name: 'Nordic OSS Fund' } },
    );
    expect(lines.map((line) => line.command)).toEqual([
      'agentfund login https://fund.nordic-oss.example --via https://fund.example',
      'agentfund approve https://fund.nordic-oss.example/fjord-db',
    ]);
  });

  it('names an instance by host and port', () => {
    expect(hostOf('https://lab.hackerspace.example:8443/')).toBe('lab.hackerspace.example:8443');
    expect(hostOf('http://localhost:8787')).toBe('localhost:8787');
  });
});

describe('keyFingerprint', () => {
  it('is the SHA-256 of the decoded key bytes, as the server computes it', async () => {
    // "Ed" + 40 zero bytes; digest checked against `openssl dgst -sha256`.
    const key = btoa(`Ed${'\0'.repeat(40)}`);
    const bytes = Uint8Array.from(atob(key), (char) => char.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(await keyFingerprint(key)).toBe(`SHA256:${hex}`);
    expect(await keyFingerprint(`  ${key}\n`)).toBe(`SHA256:${hex}`);
  });

  it('gives up on something that is not a key', async () => {
    expect(await keyFingerprint('not base64 !!')).toBeNull();
  });
});
