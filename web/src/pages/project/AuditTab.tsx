import { flatItems, useProjectEvents } from '../../api/queries';
import type { AuditEvent } from '../../api/types';
import { CopyButton } from '../../components/CopyButton';
import { Hash } from '../../components/Hash';
import { EmptyState, ErrorState, Loading, LoadMore, Notice, SkeletonRows } from '../../components/States';
import { TableScroll } from '../../components/TableScroll';
import { Time } from '../../components/Time';
import { UserLink } from '../../components/UserLink';
import { CLI_NAME } from '../../config';
import { manifestId } from '../../lib/events';
import { absoluteTime, formatExact } from '../../lib/format';
import { useProjectContext } from './ProjectPage';

function EventLog({ slug, liveEvents }: { slug: string; liveEvents: AuditEvent[] }) {
  const query = useProjectEvents(slug);
  const fetched = flatItems(query);
  const known = new Set(fetched.map((event) => event.id));
  const events = [...liveEvents.filter((event) => !known.has(event.id)), ...fetched];

  if (query.isPending) {
    return (
      <Loading label="event log">
        <SkeletonRows rows={8} height="2.5rem" />
      </Loading>
    );
  }
  if (query.isError) {
    return <ErrorState title="Couldn't load the event log" error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (events.length === 0) {
    return (
      <EmptyState title="The log is empty">
        <p>Every state change for this project is appended here and never edited.</p>
      </EmptyState>
    );
  }
  return (
    <>
      <TableScroll label="Event log">
        <table className="table table--dense">
          <thead>
            <tr>
              <th scope="col">Time (UTC)</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Task</th>
              <th scope="col">Payload</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="mono table__nowrap">{absoluteTime(event.at).replace(' UTC', '')}</td>
                <td>{event.actor ? <UserLink handle={event.actor} /> : '—'}</td>
                <td className="mono">{event.action}</td>
                <td className="mono">{event.task_id ? manifestId(event.task_id) : '—'}</td>
                <td className="mono table__payload">
                  {event.payload && Object.keys(event.payload).length > 0 ? JSON.stringify(event.payload) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <LoadMore
        hasMore={query.hasNextPage}
        loading={query.isFetchingNextPage}
        onLoad={() => void query.fetchNextPage()}
        label="Load older events"
      />
    </>
  );
}

export default function AuditTab() {
  const { project, liveEvents } = useProjectContext();
  const { trust } = project;
  const cap = (value: number | null | undefined) =>
    value == null ? 'no cap' : <span className="mono">{formatExact(value)}</span>;

  return (
    <div className="tab-panel">
      <section className="tab-panel__section" aria-labelledby="audit-identity">
        <h2 id="audit-identity">What this instance vouches for</h2>
        <p className="muted tab-panel__note">
          Nothing here asks for your trust. Each value can be checked against the repository and your own worker.
        </p>
        {project.index_error && (
          <Notice tone="strong" title="The latest commit was not indexed" role="status">
            <p>{project.index_error}</p>
          </Notice>
        )}
        <dl className="definitions definitions--wide">
          <dt>Pinned commit</dt>
          <dd>
            <Hash value={project.pinned_commit} label="pinned commit" length={12} />{' '}
            <a href={`${project.repo_url}/commit/${project.pinned_commit}`} rel="noreferrer">
              View in the repository
            </a>
            <p className="muted">
              The task list was read from this commit of <span className="mono">{project.base_branch}</span>. It is the
              commit every claim names.{' '}
              {project.follow_branch
                ? 'The pin follows the branch when a new head carries a valid signature.'
                : 'The pin only moves when the maintainer re-pins it.'}
            </p>
          </dd>

          <dt>Maintainer key</dt>
          <dd>
            <span className="key-line">
              <code className="key-line__value">{project.pubkey}</code>
              <CopyButton text={project.pubkey} label="the maintainer public key" />
            </span>
            <p className="muted">Ed25519, minisign encoding. Registered when the project was created.</p>
          </dd>

          <dt>Key fingerprint</dt>
          <dd>
            <span className="key-line">
              <code className="key-line__value">{project.pubkey_fingerprint}</code>
              <CopyButton text={project.pubkey_fingerprint} label="the key fingerprint" />
            </span>
            <p>
              Compare this with the fingerprint <code>{CLI_NAME} approve</code> prints. If they differ, do not approve:
              the key in the repository is not the one registered here.
            </p>
          </dd>

          <dt>Lock file</dt>
          <dd>
            {project.lock_sha256 ? (
              <>
                <Hash value={`sha256:${project.lock_sha256}`} label="lock file hash" length={16} />{' '}
                {project.lock_url && (
                  <a href={project.lock_url} rel="noreferrer">
                    View MANIFEST.lock
                  </a>
                )}
                <p className="muted">
                  SHA-256 of <span className="mono">tasks/MANIFEST.lock</span> at the pinned commit. The lock lists the
                  hash of every task manifest and carries the maintainer's signature.
                </p>
              </>
            ) : (
              <span className="muted">No lock indexed yet.</span>
            )}
          </dd>

          <dt>Trust tier</dt>
          <dd>
            {trust.tier === 'established' ? 'Established' : 'New'} ·{' '}
            <span className="mono">{trust.merged_tasks}</span> merged {trust.merged_tasks === 1 ? 'task' : 'tasks'}
            <p className="muted">
              Per-task ceiling: {cap(trust.max_tokens_per_task)}. Daily ceiling: {cap(trust.max_tokens_per_day)}.
              Computed from the ledger, never self-declared. Your worker applies its own limits regardless.
            </p>
          </dd>

          <dt>CI evidence</dt>
          <dd>
            {project.ci_provider === 'github' ? 'GitHub checks' : 'Signed results from the project CI'}
            <p className="muted">A run is delivered only when CI passes on the exact branch and commit it pushed.</p>
          </dd>

          <dt>Last indexed</dt>
          <dd>{project.last_indexed_at ? <Time value={project.last_indexed_at} /> : 'Never'}</dd>
        </dl>
      </section>

      <section className="tab-panel__section" aria-labelledby="audit-log">
        <h2 id="audit-log">Event log</h2>
        <p className="muted tab-panel__note">Append-only. Rows are never updated or deleted; new ones appear live.</p>
        <EventLog slug={project.slug} liveEvents={liveEvents} />
      </section>
    </div>
  );
}
