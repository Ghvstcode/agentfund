import type { LedgerEntry } from '../api/types';

export type PullRequestStage = 'awaiting_ci' | 'ci_failed' | 'closed' | 'delivered' | 'merged';

export interface PullRequest {
  url: string;
  stage: PullRequestStage;
  taskId: string | null;
  taskTitle: string | null;
  donor: LedgerEntry['donor'];
  tokens: number;
  branch: string | null;
  headSha: string | null;
  ciRunUrl: string | null;
  /** Time of the most recent ledger entry about this PR. */
  at: string;
}

/** Stage evidenced by the kind of entry alone, for servers that do not send `delivery`. */
const STAGE_BY_ENTRY: Partial<Record<LedgerEntry['type'], PullRequestStage>> = {
  report: 'awaiting_ci',
  delivery: 'delivered',
  merge: 'merged',
};
const STAGE_RANK: Record<PullRequestStage, number> = { awaiting_ci: 0, ci_failed: 1, delivered: 2, closed: 3, merged: 4 };

/** Where a report currently sits, as the server states it on `report` entries. */
const STAGE_BY_DELIVERY: Partial<Record<NonNullable<LedgerEntry['delivery']>, PullRequestStage>> = {
  pending_ci: 'awaiting_ci',
  ci_failed: 'ci_failed',
  delivered: 'delivered',
  merged: 'merged',
  closed: 'closed',
};

/**
 * Fold ledger entries into one row per pull request. The stage is the report's current
 * `delivery` when the server sends it (this is the only way to learn of a CI failure or a
 * PR closed unmerged); otherwise the furthest stage the entry types give evidence for.
 * Entries without a PR (pledges, failed runs) are skipped. Newest activity first.
 */
export function pullRequestsFromLedger(entries: readonly LedgerEntry[]): PullRequest[] {
  const byUrl = new Map<string, PullRequest & { stated: boolean }>();
  for (const entry of entries) {
    const inferred = STAGE_BY_ENTRY[entry.type];
    if (!entry.pr_url || !inferred) continue;
    const stated = entry.type === 'report' && entry.delivery ? STAGE_BY_DELIVERY[entry.delivery] : undefined;
    const known = byUrl.get(entry.pr_url);
    if (!known) {
      byUrl.set(entry.pr_url, {
        url: entry.pr_url,
        stage: stated ?? inferred,
        stated: stated !== undefined,
        taskId: entry.task_id ?? null,
        taskTitle: entry.task_title ?? null,
        donor: entry.donor,
        tokens: entry.tokens,
        branch: entry.branch ?? null,
        headSha: entry.head_sha ?? null,
        ciRunUrl: entry.ci_run_url ?? null,
        at: entry.at,
      });
      continue;
    }
    if (stated) {
      known.stage = stated;
      known.stated = true;
    } else if (!known.stated && STAGE_RANK[inferred] > STAGE_RANK[known.stage]) {
      known.stage = inferred;
    }
    if (entry.at > known.at) known.at = entry.at;
    known.ciRunUrl ??= entry.ci_run_url ?? null;
  }
  return [...byUrl.values()]
    .map(({ stated: _stated, ...row }) => row)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** `https://github.com/o/r/pull/42` -> `#42`; anything else falls back to "PR". */
export function pullRequestLabel(url: string): string {
  const number = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url)?.[1];
  return number ? `#${number}` : 'PR';
}
