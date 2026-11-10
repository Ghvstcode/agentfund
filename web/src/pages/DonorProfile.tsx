import { Download, FolderGit2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '@/api/client';
import { useDonor, useMeta } from '@/api/queries';
import type { Donor, LedgerEntry } from '@/api/types';
import { Button } from '@/components/Button';
import { CopyButton } from '@/components/CopyButton';
import { HandleAvatar } from '@/components/HandleAvatar';
import { Mark, TokenDot } from '@/components/Mark';
import { Num } from '@/components/Num';
import { EmptyState, ErrorState, Loading, Skeleton, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { APP_NAME } from '@/config';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { manifestId } from '@/lib/events';
import { formatCompact, formatDate, formatExact } from '@/lib/format';
import { pullRequestLabel } from '@/lib/prs';
import { dailySeries } from '@/lib/series';
import { cn } from '@/lib/utils';
import NotFound from './NotFound';

const ENTRY_VERBS: Record<LedgerEntry['type'], string> = {
  pledge: 'Pledged',
  report: 'Reported a run on',
  delivery: 'Delivered',
  merge: 'Merged',
};

const GRID_DAYS = 28;

/** Per day, the strongest thing that happened: a merge, else a delivery, else nothing. */
function dayStates(donor: Donor): ('idle' | 'delivered' | 'merged')[] {
  const pick = (type: LedgerEntry['type']) =>
    dailySeries(donor.recent.filter((entry) => entry.type === type).map((entry) => ({ at: entry.at, tokens: Math.max(1, entry.tokens) })), GRID_DAYS);
  const delivered = pick('delivery');
  const merged = pick('merge');
  return delivered.map((value, index) => ((merged[index] ?? 0) > 0 ? 'merged' : value > 0 ? 'delivered' : 'idle'));
}

/** Four weeks as a grid of tokens, oldest top-left. */
function TokenGrid({ donor }: { donor: Donor }) {
  const days = dayStates(donor);
  const active = days.filter((day) => day !== 'idle').length;
  return (
    <div role="img" aria-label={`Active on ${active} of the last ${GRID_DAYS} days`} className="grid grid-cols-7 gap-[1.1cqw] sm:gap-[0.7cqw]">
      {days.map((day, index) => (
        <span
          key={index}
          className={cn(
            'aspect-square w-[5.4cqw] rounded-full sm:w-[2.4cqw]',
            day === 'idle' && 'border-[1.5px] border-white/15',
            day === 'delivered' && 'bg-pass',
            day === 'merged' && 'bg-white',
          )}
        />
      ))}
    </div>
  );
}

/**
 * The shareable card. Always dark, whatever the page theme: it is an object to screenshot,
 * and it should look the same wherever it lands. Fixed aspect ratio; the number scales with
 * the card's width.
 */
function ShareCard({ donor, instance, cardRef }: { donor: Donor; instance: string; cardRef: React.RefObject<HTMLElement | null> }) {
  return (
    <figure
      ref={cardRef}
      aria-label={`${donor.handle}: donor summary`}
      className="dark @container relative aspect-[4/5] overflow-hidden bg-[#0c0d0d] text-white sm:aspect-[2.4/1]"
    >
      <div className="relative flex size-full flex-col justify-between p-[6cqw] sm:p-[3.4cqw]">
        <header className="flex items-start justify-between gap-4">
          <span className="flex min-w-0 items-center gap-3">
            <HandleAvatar handle={donor.handle} className="size-[max(2.25rem,3.2cqw)] bg-white/10 text-sm text-white" />
            <span className="grid min-w-0">
              <span className="truncate text-[clamp(1rem,1.6cqw,1.375rem)] leading-tight font-semibold tracking-[-0.02em]">{donor.handle}</span>
              <span className="num truncate text-xs text-zinc-400">{donor.rank ? `#${donor.rank} on ${instance}` : instance}</span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-[clamp(0.8125rem,1.2cqw,1rem)] font-semibold tracking-[-0.03em]">
            <Mark className="size-[max(1.25rem,1.7cqw)] text-white" />
            {APP_NAME}
          </span>
        </header>

        <div className="flex flex-col gap-[4cqw] sm:flex-row sm:items-end sm:justify-between">
          <div className="grid gap-[3cqw] sm:gap-[2cqw]">
            <div className="grid gap-[1cqw]">
              <p className="text-[clamp(0.8125rem,1.2cqw,1rem)] text-zinc-400">Tokens delivered</p>
              <p className="num -ml-[0.04em] leading-none font-medium tracking-[-0.055em]" style={{ fontSize: 'clamp(2.5rem, 7.4cqw, 7rem)' }} title={`${formatExact(donor.delivered)} tokens`}>
                {formatExact(donor.delivered)}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-[4cqw] gap-y-3 sm:flex sm:gap-[4cqw]">
              {[
                ['Day streak', formatExact(donor.streak_days)],
                ['Tasks merged', formatExact(donor.tasks_merged)],
                ['Projects', formatExact(donor.projects_backed)],
                ['Merged tokens', formatCompact(donor.merged)],
              ].map(([label, value]) => (
                <div key={label} className="grid gap-1">
                  <dt className="text-xs text-zinc-400">{label}</dt>
                  <dd className="num text-[clamp(1.125rem,1.9cqw,1.625rem)] leading-none font-medium tracking-[-0.03em]">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="grid justify-items-start gap-2.5 sm:justify-items-end">
            <TokenGrid donor={donor} />
            <p className="num text-[0.6875rem] text-zinc-400">Last {GRID_DAYS} days · green delivered · white merged</p>
          </div>
        </div>
      </div>
    </figure>
  );
}

/** Save the card as a PNG. The renderer is loaded only when the button is used. */
function useDownloadCard(cardRef: React.RefObject<HTMLElement | null>, handle: string) {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle');
  const download = async () => {
    if (!cardRef.current) return;
    setState('working');
    try {
      const { toPng } = await import('html-to-image');
      const url = await toPng(cardRef.current, { pixelRatio: 2, cacheBust: true });
      const link = document.createElement('a');
      link.download = `${handle}-agentfund.png`;
      link.href = url;
      link.click();
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return { state, download };
}

function ProfileBody({ donor }: { donor: Donor }) {
  const meta = useMeta();
  const cardRef = useRef<HTMLElement>(null);
  const { state, download } = useDownloadCard(cardRef, donor.handle);
  const total = Math.max(1, donor.delivered);
  const sectionHead = 'flex items-end justify-between gap-3 border-b border-b-foreground pb-3.5';

  return (
    <>
      <ShareCard donor={donor} instance={meta.data?.name ?? APP_NAME} cardRef={cardRef} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="num text-xs text-muted-foreground">
          joined {formatDate(donor.joined_at)}
          {donor.github_login && (
            <>
              {' · '}
              <a href={`https://github.com/${donor.github_login}`} rel="noreferrer" className="hover:text-foreground hover:underline">
                github.com/{donor.github_login} ↗
              </a>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          {state === 'failed' && (
            <span role="status" className="text-xs text-muted-foreground">
              Couldn't render the image. A screenshot works too.
            </span>
          )}
          <Button onClick={() => void download()} busy={state === 'working'} busyLabel="Rendering…" className="rounded-none">
            <Download strokeWidth={1.5} aria-hidden="true" />
            Download PNG
          </Button>
          <CopyButton text={donor.id} label="the link to this profile" caption="Copy link" className="h-9 rounded-none px-3" />
        </div>
      </div>

      <div className="grid gap-12 pt-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:gap-14">
        <section aria-labelledby="profile-projects" className="grid min-w-0 content-start">
          <div className={sectionHead}>
            <h2 id="profile-projects" className="text-2xl font-semibold tracking-[-0.03em]">
              Projects backed
            </h2>
            <span className="num text-xs text-muted-foreground">{donor.projects_backed}</span>
          </div>
          {donor.projects.length === 0 ? (
            <EmptyState className="mt-4" icon={FolderGit2} title="No projects backed yet" action={<Button asChild variant="primary"><Link to="/">Find a project</Link></Button>}>
              <p>{donor.handle} has an account here but has not pledged or delivered anything so far.</p>
            </EmptyState>
          ) : (
            <ul aria-label={`Projects backed by ${donor.handle}`}>
              {donor.projects.map((project) => {
                const share = Math.round((project.delivered / total) * 100);
                return (
                  <li key={project.slug} className="relative flex items-center gap-5 border-b py-3.5 hover:bg-muted/40">
                    <div className="grid min-w-0 flex-1">
                      <Link to={`/${project.slug}`} className="truncate text-[0.9375rem] font-semibold after:absolute after:inset-0 focus-visible:outline-none">
                        {project.name}
                      </Link>
                      <span className="num text-xs text-muted-foreground">
                        {formatCompact(project.merged)} merged{project.pledged > 0 && ` · ${formatCompact(project.pledged)} pledged`}
                      </span>
                    </div>
                    <div className="hidden w-48 gap-1.5 sm:grid">
                      <span className="block h-1 bg-muted" aria-hidden="true">
                        <span className="block h-1 bg-pass" style={{ width: `${share}%` }} />
                      </span>
                      <span className="num text-[0.6875rem] text-muted-foreground">{share}% of their delivery</span>
                    </div>
                    <Num value={project.delivered} className="w-16 text-right text-[0.875rem] font-medium text-live" />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="profile-recent" className="grid min-w-0 content-start">
          <div className={sectionHead}>
            <h2 id="profile-recent" className="text-2xl font-semibold tracking-[-0.03em]">
              Recent work
            </h2>
          </div>
          {donor.recent.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No runs reported yet.</p>
          ) : (
            <ol>
              {donor.recent.map((entry) => {
                const counted = entry.type === 'delivery' || entry.type === 'merge';
                return (
                  <li key={entry.id} className="flex items-center gap-3.5 border-b py-3.5 text-[0.8125rem]">
                    <TokenDot
                      state={entry.type === 'merge' ? 'merged' : entry.type === 'delivery' ? 'delivered' : entry.type === 'report' ? 'reported' : 'pledged'}
                    />
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <p className="min-w-0 truncate">
                        {entry.task_id && entry.project ? (
                          <Link to={`/${entry.project}/tasks/${manifestId(entry.task_id)}`} className="num hover:underline">
                            {manifestId(entry.task_id)}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{ENTRY_VERBS[entry.type]}</span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {entry.project && (
                          <Link to={`/${entry.project}`} className="hover:underline">
                            {entry.project}
                          </Link>
                        )}
                        {' · '}
                        {ENTRY_VERBS[entry.type].toLowerCase()}
                        {entry.pr_url && /^https?:/.test(entry.pr_url) && (
                          <>
                            {' · '}
                            <a href={entry.pr_url} rel="noreferrer" className="num hover:underline">
                              {pullRequestLabel(entry.pr_url)}
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="grid justify-items-end gap-0.5 text-xs">
                      <Num value={entry.tokens} className={cn('text-[0.8125rem]', counted ? 'font-medium text-live' : 'text-muted-foreground')} />
                      <Time value={entry.at} className="text-muted-foreground" />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
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
    <section className="container-page grid grid-cols-[minmax(0,1fr)] gap-4 py-8 sm:py-10">
      <p className="num text-xs text-muted-foreground">
        <Link to="/donors" className="hover:text-foreground">
          Leaderboard
        </Link>{' '}
        / <span className="text-foreground">{handle}</span>
      </p>
      <h1 className="sr-only">
        {handle}: {donor.data ? `${formatCompact(donor.data.delivered)} tokens delivered` : 'donor profile'}
      </h1>
      {donor.isPending ? (
        <Loading label="donor profile" className="grid gap-4">
          <Skeleton className="aspect-[4/5] h-auto rounded-none sm:aspect-[2.4/1]" />
          <Skeleton className="h-8" />
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
