import { describe, expect, it, vi } from 'vitest';
import { session, tokenFromFragment } from './session';

describe('session', () => {
  it('stores the token, notifies subscribers, and clears', () => {
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    session.setToken('afs_abc');
    expect(session.getToken()).toBe('afs_abc');
    expect(window.localStorage.getItem('agentfund.session')).toBe('afs_abc');
    session.clear();
    expect(session.getToken()).toBeNull();
    expect(window.localStorage.getItem('agentfund.session')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('reads the token from the OAuth redirect fragment', () => {
    expect(tokenFromFragment('#token=afs_123')).toBe('afs_123');
    expect(tokenFromFragment('#state=x&token=afs_123')).toBe('afs_123');
  });

  it('rejects fragments without a session token', () => {
    expect(tokenFromFragment('')).toBeNull();
    expect(tokenFromFragment('#token=')).toBeNull();
    expect(tokenFromFragment('#token=af_worker_key')).toBeNull();
  });
});
