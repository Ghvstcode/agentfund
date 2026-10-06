import { Link, useParams } from 'react-router';
import { ApiError } from '../api/client';
import { useDonor, useMeta } from '../api/queries';
import type { Donor, LedgerEntry } from '../api/types';
import { CopyButton } from '../components/CopyButton';
import { Num } from '../components/Num';
import { EmptyState, ErrorState, Loading, Skeleton, SkeletonRows } from '../components/States';
import { TableScroll } from '../components/TableScroll';
import { Time } from '../components/Time';
import { APP_NAME } from '../config';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { manifestId } from '../lib/events';
import { digitGroups, formatDate, formatExact } from '../lib/format';
import { pullRequestLabel } from '../lib/prs';
import NotFound from './NotFound';

const ENTRY_VERBS: Record<LedgerEntry['type'], string> = {
  pledge: 'Pledged',
  report: 'Reported a run',
  delivery: 'Delivered',
  merge: 'Merged',
};

/** The shareable card: a fixed-ratio summary that reads well as a screenshot in either theme. */
function ShareCard({ donor, instance }: { donor: Donor; instance: string }) {
  return (
    <figure className="share-card" aria-label={`${donor.handle}: donor summary`}>
      <header className="share-card__top">
        <span className="share-card__instance">{instance}</span>
        <span className="share-card__rank mono">{donor.rank ? `#${donor.rank}` : 'Unranked'}</span>
      </header>
      <div className="share-card__main">
        <p className="share-card__handle">{donor.handle}</p>
        <p className="share-card__number mono" title={`${formatExact(donor.delivered)} tokens`}>
          {digitGroups(donor.delivered).map((group, index) => (
            <span key={index}>{group}</span>
          ))}
        </p>
        <p className="share-card__caption">tokens delivered to open source</p>
      </div>
      <dl className="share-card__stats">
        <div>
          <dt>Tasks merged</dt>
          <dd className="mono">{donor.tasks_merged}</dd>
        </div>
        <div>
          <dt>Projects backed</dt>
          <dd className="mono">{donor.projects_backed}</dd>
        </div>
        <div>
          <dt>Day streak</dt>
          <dd className="mono">{donor.streak_days}</dd>
        </div>
        <div>
          <dt>Merged tokens</dt>
          <dd>
            <Num value={donor.merged} />
          </dd>
        </div>
      </dl>
    </figure>
  );
}

function ProfileBody({ donor }: { donor: Donor }) {
  const meta = useMeta();
  const largest = Math.max(1, ...donor.projects.map((project) => project.delivered));

  return (
    <>
      <ShareCard donor={donor} instance={meta.data?.name ?? APP_NAME} />
      <p className="profile__share muted">
        Joined {formatDate(donor.joined_at)}
        {donor.github_login && (
          <>
            {' · '}
            <a href={`https://github.com/${donor.github_login}`} rel="noreferrer">
              github.com/{donor.github_login}
            </a>
          </>
        )}
        {' · '}
        <CopyButton text={donor.id} label="the link to this profile" caption="Copy link" />
      </p>

      <section className="profile__section" aria-labelledby="profile-projects">
        <h2 id="profile-projects">Projects backed</h2>
        {donor.projects.length === 0 ? (
          <EmptyState title="No projects backed yet">
            <p>{donor.handle} has an account here but has not pledged or delivered anything so far.</p>
          </EmptyState>
        ) : (
          <TableScroll label={`Projects backed by ${donor.handle}`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col" className="table__bar-cell">
                    <span className="sr-only">Share of delivered tokens</span>
                  </th>
                  <th scope="col" className="table__num">
                    Delivered
                  </th>
                  <th scope="col" className="table__num">
                    Merged
                  </th>
                  <th scope="col" className="table__num">
                    Pledged
                  </th>
                </tr>
              </thead>
              <tbody>
                {donor.projects.map((project) => (
                  <tr key={project.slug}>
                    <th scope="row">
                      <Link to={`/${project.slug}`}>{project.name}</Link>
                    </th>
                    <td className="table__bar-cell">
                      <span className="mini-bar" aria-hidden="true">
                        <span style={{ width: `${(project.delivered / largest) * 100}%` }} />
                      </span>
                    </td>
                    <td className="table__num table__lead">
                      <Num value={project.delivered} />
                    </td>
                    <td className="table__num">
                      <Num value={project.merged} />
                    </td>
                    <td className="table__num">
                      <Num value={project.pledged} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>

      <section className="profile__section" aria-labelledby="profile-recent">
        <h2 id="profile-recent">Recent runs</h2>
        {donor.recent.length === 0 ? (
          <p className="muted">No runs reported yet.</p>
        ) : (
          <ol className="event-list">
            {donor.recent.map((entry) => (
              <li key={entry.id}>
                <div className="event-line" data-delivery={entry.type === 'delivery' || entry.type === 'merge' || undefined}>
                  <p className="event-line__text">
                    {ENTRY_VERBS[entry.type]}{' '}
                    {entry.task_id && entry.project ? (
                      <Link to={`/${entry.project}/tasks/${manifestId(entry.task_id)}`}>
                        {entry.task_title ?? manifestId(entry.task_id)}
                      </Link>
                    ) : null}
                    {entry.project && (
                      <>
                        {' in '}
                        <Link to={`/${entry.project}`}>{entry.project}</Link>
                      </>
                    )}
                    {entry.pr_url && (
                      <>
                        {' · '}
                        <a href={entry.pr_url} rel="noreferrer" className="mono">
                          {pullRequestLabel(entry.pr_url)}
                        </a>
                      </>
                    )}
                  </p>
                  <p className="event-line__meta">
                    <Num value={entry.tokens} />
                    <Time value={entry.at} />
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

export default function DonorProfile() {
  const { handle = '' } = useParams();
  const donor = useDonor(handle);
  useDocumentTitle(handle);

  if (donor.isError && donor.error instanceof ApiError && donor.error.status === 404) {
    return <NotFound what={`a donor called “${handle}”`} />;
  }

  return (
    <section className="page page--medium profile">
      <h1 className="sr-only">{handle}</h1>
      {donor.isPending ? (
        <Loading label="donor profile">
          <div className="share-card share-card--loading">
            <Skeleton width="30%" height="1.2rem" />
            <Skeleton width="70%" height="4rem" />
            <Skeleton height="3rem" />
          </div>
          <SkeletonRows rows={4} />
        </Loading>
      ) : donor.isError ? (
        <ErrorState title="Couldn't load this profile" error={donor.error} onRetry={() => void donor.refetch()} />
      ) : (
        <ProfileBody donor={donor.data} />
      )}
    </section>
  );
}
