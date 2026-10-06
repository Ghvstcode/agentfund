import type { LedgerEntry } from '../api/types';

export type PullRequestStage = 'awaiting_ci' | 'delivered' | 'merged';

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

const STAGE_RANK: Record<PullRequestStage, number> = { awaiting_ci: 0, delivered: 1, merged: 2 };
const STAGE_BY_ENTRY: Partial<Record<LedgerEntry['type'], PullRequestStage>> = {
  report: 'awaiting_ci',
  delivery: 'delivered',
  merge: 'merged',
};

/**
 * Fold ledger entries into one row per pull request, at the furthest stage the ledger has
 * evidence for. Entries without a PR (pledges, failed runs) are skipped. Order follows the
 * newest entry for each PR.
 */
export function pullRequestsFromLedger(entries: readonly LedgerEntry[]): PullRequest[] {
  const byUrl = new Map<string, PullRequest>();
  for (const entry of entries) {
    const stage = STAGE_BY_ENTRY[entry.type];
    if (!entry.pr_url || !stage) continue;
    const known = byUrl.get(entry.pr_url);
    if (!known) {
      byUrl.set(entry.pr_url, {
        url: entry.pr_url,
        stage,
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
    if (STAGE_RANK[stage] > STAGE_RANK[known.stage]) known.stage = stage;
    if (entry.at > known.at) known.at = entry.at;
    known.ciRunUrl ??= entry.ci_run_url ?? null;
  }
  return [...byUrl.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** `https://github.com/o/r/pull/42` -> `#42`; anything else falls back to "PR". */
export function pullRequestLabel(url: string): string {
  const number = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url)?.[1];
  return number ? `#${number}` : 'PR';
}
