import { FileSearch } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { useTask } from '@/api/queries';
import type { Report, Task } from '@/api/types';
import { CopyButton } from '@/components/CopyButton';
import { Dialog, DialogSection } from '@/components/Dialog';
import { Hash } from '@/components/Hash';
import { Num } from '@/components/Num';
import { EmptyState, ErrorState, Loading, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { TokenCounter } from '@/components/TokenCounter';
import { UserLink } from '@/components/UserLink';
import { formatCompact, formatDuration, formatExact, formatUsd } from '@/lib/format';
import { pullRequestLabel } from '@/lib/prs';
import { cn } from '@/lib/utils';
import { taskStatus } from './taskStates';

const REPORT_STATUS: Record<Report['status'], string> = {
  completed: 'Completed',
  failed: 'Failed',
  verification_failed: 'Verification failed',
  budget_exceeded: 'Budget exceeded',
  timeout: 'Timed out',
};

const DELIVERY: Record<Report['delivery'], string> = {
  none: 'Not a completed run',
  pending_ci: 'Awaiting CI',
  ci_failed: 'CI failed',
  delivered: 'Delivered (CI passed)',
  merged: 'Merged',
  closed: 'PR closed without merging',
};

/** A two-column list of facts: muted label, value. */
function Facts({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <dl className="grid border-b text-[0.8125rem]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-6 border-t py-2.5">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Globs({ globs, strong }: { globs: string[]; strong?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {globs.map((glob) => (
        <li key={glob} className={cn('num px-2 py-1 text-xs', strong ? 'bg-muted text-foreground' : 'border text-muted-foreground')}>
          {glob}
        </li>
      ))}
    </ul>
  );
}

function ReportFacts({ report }: { report: Report }) {
  const rows: [string, ReactNode][] = [
    [
      'Outcome',
      <span key="o">
        {REPORT_STATUS[report.status]} · {DELIVERY[report.delivery]}
        {report.flagged_late && ' · reported late, not counted'}
      </span>,
    ],
    [
      'Donor',
      <span key="d" className="inline-flex flex-wrap items-center gap-x-2">
        <UserLink handle={report.donor.handle} avatar /> <Time value={report.created_at} className="text-muted-foreground" />
      </span>,
    ],
    [
      'Tokens',
      <span key="t" className="num">
        {formatExact(report.tokens_in)} in · {formatExact(report.tokens_out)} out
      </span>,
    ],
    [
      'API-equivalent',
      <span key="c">
        <span className="num">{formatUsd(report.cost_estimate)}</span>{' '}
        <span className="text-muted-foreground">estimated by the runner</span>
      </span>,
    ],
  ];
  if (report.pr_url) {
    rows.push([
      'Pull request',
      <span key="p" className="inline-flex flex-wrap items-center gap-x-2">
        {/^https?:/.test(report.pr_url) ? (
          <a href={report.pr_url} rel="noreferrer" className="link num">
            {pullRequestLabel(report.pr_url)}
          </a>
        ) : (
          <span className="num">{pullRequestLabel(report.pr_url)}</span>
        )}
        {report.branch && <span className="num text-xs text-muted-foreground">{report.branch}</span>}
      </span>,
    ]);
  }
  if (report.head_sha) rows.push(['Head commit', <Hash key="h" value={report.head_sha} label="head commit" />]);
  if (report.ci) {
    rows.push([
      'CI',
      <span key="ci">
        {report.ci.provider} · {report.ci.conclusion}
        {report.ci.run_url && (
          <>
            {' · '}
            <a href={report.ci.run_url} rel="noreferrer" className="link">
              View run
            </a>
          </>
        )}
      </span>,
    ]);
  }
  rows.push(['Verify exit', <span key="v" className="num">{report.verify_exit_code ?? 'not run'}</span>]);
  rows.push(['Run log digest', <Hash key="l" value={report.log_digest} label="run log digest" length={16} />]);
  if (report.runner || report.model) {
    rows.push(['Runner', <span key="r" className="num text-[0.8125rem]">{[report.runner, report.model].filter(Boolean).join(' · ')}</span>]);
  }
  if (report.duration_seconds != null) rows.push(['Duration', <span key="du" className="num">{formatDuration(report.duration_seconds)}</span>]);
  if (report.message) rows.push(['Message', report.message]);
  return <Facts rows={rows} />;
}

function TaskDetails({ task }: { task: Task }) {
  const { manifest, burn, active_claim: claim, latest_report: report } = task;
  const status = taskStatus(task);
  return (
    <>
      <DialogSection>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('flex h-6 items-center gap-1.5 px-2 text-xs font-medium', status.live ? 'bg-pass-tint text-live' : 'bg-muted text-muted-foreground')}>
            {status.live ? <span className="live-dot size-1.5" aria-hidden="true" /> : <status.icon className="size-3" strokeWidth={1.75} aria-hidden="true" />}
            {status.label}
          </span>
          <span className="num text-xs text-muted-foreground">
            cap {formatCompact(manifest.max_tokens)} tokens · {manifest.timeout_minutes ?? 60} min
          </span>
          {task.blocked_by.length > 0 && (
            <span className="text-xs text-muted-foreground">
              waits for <span className="num text-foreground">{task.blocked_by.join(', ')}</span>
            </span>
          )}
        </div>
        {claim && (
          <div className="grid gap-3 bg-muted px-4 py-4">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[0.8125rem]">
              <span>
                {claim.donor ? <UserLink handle={claim.donor.handle} className="font-semibold" /> : 'A donor'}{' '}
                <span className="text-muted-foreground">is running this now</span>
              </span>
              <TokenCounter value={claim.tokens_so_far ?? 0} label="tokens so far" size="lg" tone="accent" />
            </p>
            <span className="block h-1 bg-border" aria-hidden="true">
              <span
                className="block h-1 bg-pass transition-[width] duration-500"
                style={{ width: `${Math.min(100, ((claim.tokens_so_far ?? 0) / Math.max(manifest.max_tokens, 1)) * 100)}%` }}
              />
            </span>
            <p className="num text-[0.6875rem] text-muted-foreground">
              {claim.phase ? `Phase: ${claim.phase}. ` : ''}
              {claim.claimed_at && (
                <>
                  Claimed <Time value={claim.claimed_at} />.
                </>
              )}
            </p>
          </div>
        )}
        <Facts
          rows={[
            [
              'Token cap',
              <span key="cap">
                <span className="num">{formatExact(manifest.max_tokens)}</span> <span className="text-muted-foreground">hard limit per run</span>
              </span>,
            ],
            ['Time cap', <span key="time" className="num">{manifest.timeout_minutes ?? 60} min</span>],
            [
              'Burn so far',
              <span key="burn">
                <Num value={burn.total} exact />{' '}
                <span className="text-muted-foreground">
                  across {burn.runs} {burn.runs === 1 ? 'run' : 'runs'}
                </span>
              </span>,
            ],
            ['Depends on', <span key="deps" className="num">{task.depends_on.length > 0 ? task.depends_on.join(', ') : 'nothing'}</span>],
          ]}
        />
      </DialogSection>

      <DialogSection title="Prompt" id="task-prompt">
        <div className="-mt-1 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Handed to the agent verbatim.</p>
          <CopyButton text={manifest.prompt} label="the prompt" caption="Copy" />
        </div>
        <pre className="prose-block">{manifest.prompt}</pre>
      </DialogSection>

      <DialogSection title="Scope" id="task-scope">
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <p className="label">May write</p>
            <Globs globs={manifest.scope.write} strong />
          </div>
          <div className="grid gap-1.5">
            <p className="label">May read</p>
            {manifest.scope.read ? <Globs globs={manifest.scope.read} /> : <p className="text-sm">The whole repository</p>}
          </div>
        </div>
        <p className="text-xs text-pretty text-muted-foreground">
          A run that changes any other path is discarded. <code className="text-foreground">agentfund.yaml</code>,{' '}
          <code className="text-foreground">tasks/**</code> and <code className="text-foreground">.github/**</code> are never writable.
        </p>
      </DialogSection>

      <DialogSection title="Verify" id="task-verify">
        <div className="-mt-1 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Runs after the agent. Exit code 0 means pass.</p>
          <CopyButton text={manifest.verify} label="the verify command" caption="Copy" />
        </div>
        <pre className="code-block bg-foreground text-background">{manifest.verify}</pre>
      </DialogSection>

      <DialogSection title="Provenance" id="task-provenance">
        <Facts
          rows={[
            ['Content hash', <Hash key="hash" value={task.content_hash} label="manifest content hash" length={20} />],
            ['Manifest', <span key="path" className="num text-[0.8125rem]">{task.manifest_path}</span>],
            ['Pinned commit', <Hash key="commit" value={task.commit} label="pinned commit" length={12} />],
          ]}
        />
        <p className="text-xs text-pretty text-muted-foreground">
          The content hash is the SHA-256 of the manifest file, as listed in the lock the maintainer signed.
        </p>
      </DialogSection>

      <DialogSection title="Latest report" id="task-report">
        {report ? <ReportFacts report={report} /> : <p className="text-sm text-muted-foreground">No run has been reported for this task.</p>}
      </DialogSection>
    </>
  );
}

interface TaskDrawerProps {
  slug: string;
  manifestId: string;
  onClose: () => void;
}

export function TaskDrawer({ slug, manifestId, onClose }: TaskDrawerProps) {
  const task = useTask(slug, manifestId);
  const missing = task.error instanceof ApiError && task.error.status === 404;
  return (
    <Dialog
      variant="drawer"
      title={task.data?.title ?? manifestId}
      subtitle={<span className="num text-xs">{`${slug}:${manifestId}`}</span>}
      onClose={onClose}
    >
      {task.data ? (
        <TaskDetails task={task.data} />
      ) : task.isPending ? (
        <Loading label="task" className="p-5">
          <SkeletonRows rows={6} />
        </Loading>
      ) : (
        <div className="p-5">
          {missing ? (
            <EmptyState icon={FileSearch} title="No such task">
              <p>
                There is no task <span className="num text-foreground">{manifestId}</span> in the lock at the pinned commit.
              </p>
            </EmptyState>
          ) : (
            <ErrorState title="Couldn't load this task" error={task.error} onRetry={() => void task.refetch()} />
          )}
        </div>
      )}
    </Dialog>
  );
}
