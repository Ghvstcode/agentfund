import { CircleCheck, CircleX, GitMerge, GitPullRequestClosed, Hourglass, type LucideIcon, ScrollText } from 'lucide-react';
import { useLedger } from '@/api/queries';
import type { LedgerEntry } from '@/api/types';
import { Hash } from '@/components/Hash';
import { Num } from '@/components/Num';
import { EmptyState, ErrorState, Loading, LoadMore, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UserLink } from '@/components/UserLink';
import { manifestId } from '@/lib/events';
import { humanize } from '@/lib/format';
import { pullRequestLabel, pullRequestsFromLedger, type PullRequestStage } from '@/lib/prs';
import { cn } from '@/lib/utils';
import { useProjectContext } from './ProjectPage';

const STAGES: Record<PullRequestStage, { label: string; icon: LucideIcon; tone: string }> = {
  awaiting_ci: { label: 'Awaiting CI', icon: Hourglass, tone: 'text-muted-foreground' },
  ci_failed: { label: 'CI failed · task reopened', icon: CircleX, tone: 'text-destructive' },
  closed: { label: 'Closed without merging', icon: GitPullRequestClosed, tone: 'text-muted-foreground' },
  delivered: { label: 'Delivered · CI passed', icon: CircleCheck, tone: 'text-live' },
  merged: { label: 'Merged', icon: GitMerge, tone: 'text-foreground' },
};

const ENTRY_LABELS: Record<LedgerEntry['type'], string> = {
  pledge: 'Pledge',
  report: 'Run reported',
  delivery: 'Delivered',
  merge: 'Merged',
};

function entryNote(entry: LedgerEntry): string | null {
  if (entry.type === 'report' && entry.report_status && entry.report_status !== 'completed') {
    return humanize(entry.report_status);
  }
  return null;
}

const isWeb = (url: string) => /^https?:\/\//.test(url);

export default function ActivityTab() {
  const { project } = useProjectContext();
  const ledger = useLedger(project.slug);
  const entries = ledger.data?.pages.flatMap((page) => page.entries) ?? [];
  const pullRequests = pullRequestsFromLedger(entries);

  if (ledger.isPending) {
    return (
      <Loading label="activity">
        <SkeletonRows rows={6} />
      </Loading>
    );
  }
  if (ledger.isError) {
    return <ErrorState title="Couldn't load the ledger" error={ledger.error} onRetry={() => void ledger.refetch()} />;
  }
  if (entries.length === 0) {
    return (
      <EmptyState icon={ScrollText} title="No activity yet">
        <p>Pledges, reported runs, CI results and merges are listed here as the ledger records them.</p>
      </EmptyState>
    );
  }

  return (
    <div className="grid min-w-0 gap-10">
      <section aria-labelledby="prs-title" className="grid min-w-0 gap-3">
        <h2 id="prs-title" className="text-base font-semibold tracking-tight">
          Pull requests
        </h2>
        {pullRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No run has produced a pull request yet.</p>
        ) : (
          <div className="surface overflow-hidden">
            <Table aria-label="Pull requests table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Pull request</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Donor</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="hidden lg:table-cell">Head</TableHead>
                  <TableHead className="hidden pr-4 text-right sm:table-cell">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pullRequests.map((pr) => {
                  const stage = STAGES[pr.stage];
                  return (
                    <TableRow key={pr.url} className="hover:bg-muted/40">
                      <TableCell className="w-full max-w-0 pl-4">
                        <span className="flex items-baseline gap-2">
                          {isWeb(pr.url) ? (
                            <a href={pr.url} rel="noreferrer" className="link num font-medium">
                              {pullRequestLabel(pr.url)}
                            </a>
                          ) : (
                            <span className="num font-medium">{pullRequestLabel(pr.url)}</span>
                          )}
                          <span className="min-w-0 truncate">{pr.taskTitle ?? 'Unknown task'}</span>
                        </span>
                        {pr.taskId && <span className="num mt-0.5 block truncate text-xs text-muted-foreground">{manifestId(pr.taskId)}</span>}
                      </TableCell>
                      <TableCell>
                        <span className={cn('flex items-center gap-1.5 text-xs font-medium', stage.tone)}>
                          <stage.icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
                          {stage.label}
                        </span>
                        {pr.ciRunUrl && (
                          <a href={pr.ciRunUrl} rel="noreferrer" className="link mt-0.5 block text-xs text-muted-foreground">
                            CI run
                          </a>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{pr.donor ? <UserLink handle={pr.donor.handle} avatar /> : '—'}</TableCell>
                      <TableCell className="text-right">
                        <Num value={pr.tokens} />
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">{pr.headSha ? <Hash value={pr.headSha} label="head commit" /> : '—'}</TableCell>
                      <TableCell className="hidden pr-4 text-right text-muted-foreground sm:table-cell">
                        <Time value={pr.at} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section aria-labelledby="ledger-title" className="grid min-w-0 gap-3">
        <div>
          <h2 id="ledger-title" className="text-base font-semibold tracking-tight">
            Ledger
          </h2>
          <p className="text-sm text-muted-foreground">Every pledge, reported run, delivery and merge, newest first. Failed runs are listed, not hidden.</p>
        </div>
        <div className="surface overflow-hidden">
          <Table aria-label="Ledger entries table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Entry</TableHead>
                <TableHead>Donor</TableHead>
                <TableHead className="hidden sm:table-cell">Task</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="pr-4 text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id} className="hover:bg-muted/40">
                  <TableCell className="pl-4 font-medium">
                    {ENTRY_LABELS[entry.type]}
                    {entryNote(entry) && <span className="ml-2 text-xs font-normal text-muted-foreground">{entryNote(entry)}</span>}
                  </TableCell>
                  <TableCell>{entry.donor ? <UserLink handle={entry.donor.handle} avatar /> : '—'}</TableCell>
                  <TableCell className="num hidden text-xs text-muted-foreground sm:table-cell">{entry.task_id ? manifestId(entry.task_id) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <Num value={entry.tokens} exact />
                  </TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    <Time value={entry.at} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <LoadMore hasMore={ledger.hasNextPage} loading={ledger.isFetchingNextPage} onLoad={() => void ledger.fetchNextPage()} label="Load older entries" />
      </section>
    </div>
  );
}
