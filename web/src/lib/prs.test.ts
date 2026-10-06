import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../api/types';
import { pullRequestLabel, pullRequestsFromLedger } from './prs';

const entry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
  id: Math.random().toString(36),
  type: 'report',
  at: '2026-10-01T00:00:00Z',
  tokens: 100,
  ...overrides,
});

describe('pullRequestsFromLedger', () => {
  it('folds the entries of one PR into a row at its furthest stage', () => {
    const url = 'https://github.com/o/r/pull/7';
    const rows = pullRequestsFromLedger([
      entry({ type: 'merge', pr_url: url, at: '2026-10-03T00:00:00Z' }),
      entry({ type: 'delivery', pr_url: url, at: '2026-10-02T00:00:00Z', ci_run_url: 'https://ci/run/1' }),
      entry({ type: 'report', pr_url: url, at: '2026-10-01T00:00:00Z', report_status: 'completed' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url, stage: 'merged', at: '2026-10-03T00:00:00Z', ciRunUrl: 'https://ci/run/1' });
  });

  it('skips pledges and runs that produced no PR', () => {
    const rows = pullRequestsFromLedger([
      entry({ type: 'pledge' }),
      entry({ type: 'report', report_status: 'failed', pr_url: null }),
      entry({ type: 'report', report_status: 'completed', pr_url: 'https://github.com/o/r/pull/9' }),
    ]);
    expect(rows.map((row) => row.stage)).toEqual(['awaiting_ci']);
  });

  it('orders by most recent activity', () => {
    const rows = pullRequestsFromLedger([
      entry({ pr_url: 'https://github.com/o/r/pull/1', at: '2026-10-01T00:00:00Z' }),
      entry({ pr_url: 'https://github.com/o/r/pull/2', at: '2026-10-05T00:00:00Z' }),
    ]);
    expect(rows.map((row) => pullRequestLabel(row.url))).toEqual(['#2', '#1']);
  });

  it('labels PRs from other hosts', () => {
    expect(pullRequestLabel('https://gitlab.com/o/r/-/merge_requests/12')).toBe('#12');
    expect(pullRequestLabel('https://example.org/changes/abc')).toBe('PR');
  });
});
