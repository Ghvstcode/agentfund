import { useLedger } from '../../api/queries';
import type { LedgerEntry } from '../../api/types';
import { Hash } from '../../components/Hash';
import { Num } from '../../components/Num';
import { EmptyState, ErrorState, Loading, LoadMore, SkeletonRows } from '../../components/States';
import { TableScroll } from '../../components/TableScroll';
import { Time } from '../../components/Time';
import { UserLink } from '../../components/UserLink';
import { manifestId } from '../../lib/events';
import { humanize } from '../../lib/format';
import { pullRequestLabel, pullRequestsFromLedger, type PullRequestStage } from '../../lib/prs';
import { useProjectContext } from './ProjectPage';

const STAGES: Record<PullRequestStage, string> = {
  awaiting_ci: 'Awaiting CI',
  delivered: 'Delivered · CI passed',
  merged: 'Merged',
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

export default function ActivityTab() {
  const { project } = useProjectContext();
  const ledger = useLedger(project.slug);
  const entries = ledger.data?.pages.flatMap((page) => page.entries) ?? [];
  const pullRequests = pullRequestsFromLedger(entries);

  if (ledger.isPending) {
    return (
      <section className="tab-panel">
        <Loading label="activity">
          <SkeletonRows rows={6} />
        </Loading>
      </section>
    );
  }
  if (ledger.isError) {
    return (
      <section className="tab-panel">
        <ErrorState title="Couldn't load the ledger" error={ledger.error} onRetry={() => void ledger.refetch()} />
      </section>
    );
  }
  if (entries.length === 0) {
    return (
      <section className="tab-panel">
        <EmptyState title="No activity yet">
          <p>Pledges, reported runs, CI results and merges are listed here as the ledger records them.</p>
        </EmptyState>
      </section>
    );
  }

  return (
    <div className="tab-panel">
      <section className="tab-panel__section" aria-labelledby="prs-title">
        <h2 id="prs-title">Pull requests</h2>
        {pullRequests.length === 0 ? (
          <p className="muted">No run has produced a pull request yet.</p>
        ) : (
          <TableScroll label="Pull requests">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Pull request</th>
                  <th scope="col">Task</th>
                  <th scope="col">Status</th>
                  <th scope="col">Donor</th>
                  <th scope="col" className="table__num">
                    Tokens
                  </th>
                  <th scope="col">Head</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {pullRequests.map((pr) => (
                  <tr key={pr.url}>
                    <td>
                      <a href={pr.url} rel="noreferrer" className="mono">
                        {pullRequestLabel(pr.url)}
                      </a>
                    </td>
                    <td>
                      {pr.taskTitle ?? 'Unknown task'}
                      {pr.taskId && <span className="table__sub mono">{manifestId(pr.taskId)}</span>}
                    </td>
                    <td>
                      {STAGES[pr.stage]}
                      {pr.ciRunUrl && (
                        <span className="table__sub">
                          <a href={pr.ciRunUrl} rel="noreferrer">
                            CI run
                          </a>
                        </span>
                      )}
                    </td>
                    <td>{pr.donor ? <UserLink handle={pr.donor.handle} /> : '—'}</td>
                    <td className="table__num">
                      <Num value={pr.tokens} />
                    </td>
                    <td>{pr.headSha ? <Hash value={pr.headSha} label="head commit" /> : '—'}</td>
                    <td>
                      <Time value={pr.at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section className="tab-panel__section" aria-labelledby="ledger-title">
        <h2 id="ledger-title">Ledger</h2>
        <p className="muted">Every pledge, reported run, delivery and merge, newest first. Failed runs are listed, not hidden.</p>
        <TableScroll label="Ledger entries">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Donor</th>
                <th scope="col">Task</th>
                <th scope="col" className="table__num">
                  Tokens
                </th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {ENTRY_LABELS[entry.type]}
                    {entryNote(entry) && <span className="table__sub">{entryNote(entry)}</span>}
                  </td>
                  <td>{entry.donor ? <UserLink handle={entry.donor.handle} /> : '—'}</td>
                  <td>{entry.task_id ? <span className="mono">{manifestId(entry.task_id)}</span> : '—'}</td>
                  <td className="table__num">
                    <Num value={entry.tokens} exact />
                  </td>
                  <td>
                    <Time value={entry.at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <LoadMore
          hasMore={ledger.hasNextPage}
          loading={ledger.isFetchingNextPage}
          onLoad={() => void ledger.fetchNextPage()}
          label="Load older entries"
        />
      </section>
    </div>
  );
}
