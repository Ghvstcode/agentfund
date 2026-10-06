import type { Report, Task } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Dialog } from '../../components/Dialog';
import { Hash } from '../../components/Hash';
import { Num } from '../../components/Num';
import { EmptyState, Loading, Notice, SkeletonRows } from '../../components/States';
import { Time } from '../../components/Time';
import { TokenCounter } from '../../components/TokenCounter';
import { UserLink } from '../../components/UserLink';
import { formatDuration, formatExact, formatUsd } from '../../lib/format';
import { pullRequestLabel } from '../../lib/prs';
import { STATE_LABELS } from './taskStates';

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

function ReportDetails({ report }: { report: Report }) {
  return (
    <dl className="definitions">
      <dt>Outcome</dt>
      <dd>
        {REPORT_STATUS[report.status]} · {DELIVERY[report.delivery]}
        {report.flagged_late && ' · reported late, not counted'}
      </dd>
      <dt>Donor</dt>
      <dd>
        <UserLink handle={report.donor.handle} /> · <Time value={report.created_at} />
      </dd>
      <dt>Tokens</dt>
      <dd className="mono">
        {formatExact(report.tokens_in)} in · {formatExact(report.tokens_out)} out
      </dd>
      <dt>API-equivalent cost</dt>
      <dd>
        <span className="mono">{formatUsd(report.cost_estimate)}</span>{' '}
        <span className="muted">estimated by the runner, informational</span>
      </dd>
      {report.pr_url && (
        <>
          <dt>Pull request</dt>
          <dd>
            <a href={report.pr_url} rel="noreferrer">
              {pullRequestLabel(report.pr_url)}
            </a>
            {report.branch && <span className="mono muted"> {report.branch}</span>}
          </dd>
        </>
      )}
      {report.head_sha && (
        <>
          <dt>Head commit</dt>
          <dd>
            <Hash value={report.head_sha} label="head commit" />
          </dd>
        </>
      )}
      {report.ci && (
        <>
          <dt>CI</dt>
          <dd>
            {report.ci.provider} · {report.ci.conclusion}
            {report.ci.run_url && (
              <>
                {' · '}
                <a href={report.ci.run_url} rel="noreferrer">
                  View run
                </a>
              </>
            )}
          </dd>
        </>
      )}
      <dt>Verify exit code</dt>
      <dd className="mono">{report.verify_exit_code ?? 'not run'}</dd>
      <dt>Run log digest</dt>
      <dd>
        <Hash value={report.log_digest} label="run log digest" length={16} />
      </dd>
      {(report.runner || report.model) && (
        <>
          <dt>Runner</dt>
          <dd className="mono">{[report.runner, report.model].filter(Boolean).join(' · ')}</dd>
        </>
      )}
      {report.duration_seconds != null && (
        <>
          <dt>Duration</dt>
          <dd className="mono">{formatDuration(report.duration_seconds)}</dd>
        </>
      )}
      {report.message && (
        <>
          <dt>Message</dt>
          <dd>{report.message}</dd>
        </>
      )}
    </dl>
  );
}

function TaskDetails({ task }: { task: Task }) {
  const { manifest, burn, active_claim: claim, latest_report: report } = task;
  return (
    <>
      <section className="dialog-section" aria-label="Summary">
        <div className="drawer-summary">
          <Badge tone={task.state === 'claimed' && claim ? 'live' : 'strong'}>{STATE_LABELS[task.state]}</Badge>
          {task.claimable && <Badge>Claimable</Badge>}
          {task.blocked_by.length > 0 && <Badge>Blocked</Badge>}
        </div>
        {claim && (
          <Notice>
            <p className="in-flight" data-active>
              <span className="live-dot" aria-hidden="true" />
              <span>{claim.donor ? <UserLink handle={claim.donor.handle} /> : 'A donor'} is running this now</span>
              <TokenCounter value={claim.tokens_so_far ?? 0} label="tokens so far" size="md" tone="accent" />
            </p>
            <p className="muted">
              {claim.phase ? `Phase: ${claim.phase}. ` : ''}
              {claim.claimed_at && (
                <>
                  Claimed <Time value={claim.claimed_at} />.
                </>
              )}
            </p>
          </Notice>
        )}
        <dl className="definitions">
          <dt>Content hash</dt>
          <dd>
            <Hash value={task.content_hash} label="manifest content hash" length={16} />{' '}
            <span className="muted">SHA-256 of the manifest file, as signed in the lock</span>
          </dd>
          <dt>Manifest</dt>
          <dd className="mono">{task.manifest_path}</dd>
          <dt>Pinned commit</dt>
          <dd>
            <Hash value={task.commit} label="pinned commit" />
          </dd>
          <dt>Token cap</dt>
          <dd>
            <span className="mono">{formatExact(manifest.max_tokens)}</span>{' '}
            <span className="muted">hard limit per run</span>
          </dd>
          <dt>Time cap</dt>
          <dd className="mono">{manifest.timeout_minutes ?? 60} min</dd>
          <dt>Burn so far</dt>
          <dd>
            <Num value={burn.total} exact />{' '}
            <span className="muted">
              across {burn.runs} {burn.runs === 1 ? 'run' : 'runs'}
            </span>
          </dd>
          <dt>Depends on</dt>
          <dd className="mono">{task.depends_on.length > 0 ? task.depends_on.join(', ') : 'nothing'}</dd>
          {task.blocked_by.length > 0 && (
            <>
              <dt>Blocked by</dt>
              <dd className="mono">{task.blocked_by.join(', ')}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="dialog-section" aria-labelledby="task-prompt">
        <h3 id="task-prompt">Prompt</h3>
        <p className="muted">Handed to the agent verbatim.</p>
        <pre className="code-block">{manifest.prompt}</pre>
      </section>

      <section className="dialog-section" aria-labelledby="task-scope">
        <h3 id="task-scope">Scope</h3>
        <dl className="definitions">
          <dt>May write</dt>
          <dd>
            <ul className="glob-list mono">
              {manifest.scope.write.map((glob) => (
                <li key={glob}>{glob}</li>
              ))}
            </ul>
          </dd>
          <dt>May read</dt>
          <dd>
            {manifest.scope.read ? (
              <ul className="glob-list mono">
                {manifest.scope.read.map((glob) => (
                  <li key={glob}>{glob}</li>
                ))}
              </ul>
            ) : (
              'the whole repository'
            )}
          </dd>
        </dl>
        <p className="muted">
          A run that changes any other path is discarded. <code>agentfund.yaml</code>, <code>tasks/**</code> and{' '}
          <code>.github/**</code> are never writable.
        </p>
      </section>

      <section className="dialog-section" aria-labelledby="task-verify">
        <h3 id="task-verify">Verify</h3>
        <p className="muted">Runs after the agent. Exit code 0 means pass.</p>
        <pre className="code-block">{manifest.verify}</pre>
      </section>

      <section className="dialog-section" aria-labelledby="task-report">
        <h3 id="task-report">Latest report</h3>
        {report ? <ReportDetails report={report} /> : <p className="muted">No run has been reported for this task.</p>}
      </section>
    </>
  );
}

interface TaskDrawerProps {
  manifestId: string;
  tasks: Task[];
  /** False while more tasks may still arrive. */
  loaded: boolean;
  onClose: () => void;
}

export function TaskDrawer({ manifestId, tasks, loaded, onClose }: TaskDrawerProps) {
  const task = tasks.find((candidate) => candidate.task_id === manifestId);
  return (
    <Dialog
      variant="drawer"
      title={task?.title ?? manifestId}
      subtitle={<span className="mono">{task?.id ?? manifestId}</span>}
      onClose={onClose}
    >
      {task ? (
        <TaskDetails task={task} />
      ) : loaded ? (
        <EmptyState title="No such task">
          <p>
            There is no task <span className="mono">{manifestId}</span> in the lock at the pinned commit.
          </p>
        </EmptyState>
      ) : (
        <Loading label="task">
          <SkeletonRows rows={6} />
        </Loading>
      )}
    </Dialog>
  );
}
