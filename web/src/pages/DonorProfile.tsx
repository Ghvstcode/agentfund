import { ArrowUpRight, Download, Flame, FolderGit2, GitMerge, Medal } from 'lucide-react';
import { type CSSProperties, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '@/api/client';
import { useDonor, useMeta } from '@/api/queries';
import type { Donor, LedgerEntry } from '@/api/types';
import { Button } from '@/components/Button';
import { CopyButton } from '@/components/CopyButton';
import { Handle } from '@/components/Handle';
import { HandleAvatar } from '@/components/HandleAvatar';
import { InstanceBadge } from '@/components/InstanceBadge';
import { Num } from '@/components/Num';
import { EmptyState, ErrorState, Loading, Skeleton, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { APP_NAME } from '@/config';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { manifestId } from '@/lib/events';
import { digitGroups, formatCompact, formatDate, formatExact } from '@/lib/format';
import { profilePath, splitHandle } from '@/lib/handles';
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

const HEAT_DAYS = 28;
/** Opacity steps for the heat strip, from "nothing" to "the busiest day". */
const HEAT = ['bg-white/8', 'bg-live/30', 'bg-live/55', 'bg-live/80', 'bg-live'] as const;

/** One cell per day: how much of the busiest recent day's delivery happened on it. */
function HeatStrip({ donor }: { donor: Donor }) {
  const deliveries = donor.recent.filter((entry) => entry.type === 'delivery').map((entry) => ({ at: entry.at, tokens: entry.tokens }));
  const series = dailySeries(deliveries, HEAT_DAYS);
  const peak = Math.max(...series);
  const active = series.filter((value) => value > 0).length;
  return (
    <div
      role="img"
      aria-label={`Recent deliveries: active on ${active} of the last ${HEAT_DAYS} days`}
      className="grid grid-flow-col grid-rows-1 gap-[3px]"
    >
      {series.map((value, index) => (
        <span
          key={index}
          className={cn('h-6 w-full rounded-[3px]', HEAT[value === 0 || peak === 0 ? 0 : Math.max(1, Math.ceil((value / peak) * 4))])}
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
      className="dark @container relative aspect-[4/5] overflow-hidden rounded-2xl bg-[#09090b] p-px text-zinc-100 shadow-raised sm:aspect-[1.91/1]"
      // A hairline that catches the accent in one corner and fades to a plain edge.
      style={{ backgroundImage: 'linear-gradient(135deg, color-mix(in oklab, var(--live) 70%, transparent), rgb(255 255 255 / 0.14) 28%, rgb(255 255 255 / 0.06) 70%, color-mix(in oklab, var(--live) 35%, transparent))' } as CSSProperties}
    >
      <div className="relative flex size-full flex-col justify-between overflow-hidden rounded-[calc(var(--radius-2xl)-1px)] bg-[#0b0b0e] p-[6cqw] sm:p-[4.2cqw]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(60% 80% at 100% 0%, color-mix(in oklab, var(--live) 22%, transparent), transparent 70%), radial-gradient(rgb(255 255 255 / 0.05) 1px, transparent 1px)',
            backgroundSize: 'auto, 14px 14px',
          }}
        />
        <header className="relative flex items-center justify-between gap-4">
          <span className="flex min-w-0 items-center gap-2.5">
            <HandleAvatar handle={donor.handle} className="size-8 text-sm ring-white/20" />
            <span className="grid min-w-0">
              <Handle
                handle={donor.handle}
                className="truncate text-[0.9375rem] leading-tight font-semibold tracking-tight"
                hostClassName="max-w-none text-zinc-400 sm:max-w-none"
              />
              <span className="truncate text-xs text-zinc-400">{instance}</span>
            </span>
          </span>
          <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 text-xs font-medium">
            <Medal className="size-3.5 text-zinc-400" strokeWidth={1.5} aria-hidden="true" />
            {donor.rank ? (
              <>
                Rank <span className="num">#{donor.rank}</span>
              </>
            ) : (
              'Unranked'
            )}
          </span>
        </header>

        <div className="relative grid gap-[1.2cqw]">
          <p className="text-[clamp(0.75rem,2.1cqw,0.9375rem)] font-medium text-zinc-400">Tokens delivered to open source</p>
          <p
            className="num -ml-[0.04em] flex gap-[0.22em] leading-none font-medium tracking-[-0.045em] text-white"
            style={{ fontSize: 'clamp(2.5rem, 15cqw, 7rem)' }}
            title={`${formatExact(donor.delivered)} tokens`}
          >
            {digitGroups(donor.delivered).map((group, index) => (
              <span key={index}>{group}</span>
            ))}
          </p>
        </div>

        <div className="relative grid gap-[3cqw] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <dl className="grid grid-cols-3 gap-4 text-sm">
            {[
              [Flame, 'Day streak', donor.streak_days],
              [GitMerge, 'Tasks merged', donor.tasks_merged],
              [FolderGit2, 'Projects', donor.projects_backed],
            ].map(([Icon, label, value]) => {
              const Glyph = Icon as typeof Flame;
              return (
                <div key={label as string} className="grid gap-1">
                  <dt className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <Glyph className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
                    {label as string}
                  </dt>
                  <dd className="num text-xl leading-none font-medium">{value as number}</dd>
                </div>
              );
            })}
          </dl>
          <div className="grid w-full gap-1.5 sm:w-[34cqw]">
            <HeatStrip donor={donor} />
            <p className="text-right text-[0.6875rem] text-zinc-500">Last {HEAT_DAYS} days</p>
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

/**
 * For a donor whose account lives on a peer: say so, and link to the profile at home. Their
 * `id` is that profile's URL.
 */
function HomeInstance({ donor, host }: { donor: Donor; host: string }) {
  const { name } = splitHandle(donor.handle);
  const home = /^https?:/.test(donor.id) ? donor.id : null;
  return (
    <div className="grid items-center gap-x-6 gap-y-2 rounded-lg border bg-muted/30 px-3.5 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
      <p className="min-w-0 leading-relaxed text-pretty text-muted-foreground">
        <InstanceBadge instance={{ host, name: host, base_url: home ? new URL(home).origin : host }} className="mr-1.5 align-middle" />
        hosts {name}'s account and vouches for it. This page shows only what {name} did here.
      </p>
      {home && (
        <a href={home} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 justify-self-start font-medium whitespace-nowrap">
          Profile at home
          <ArrowUpRight className="size-3.5 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">
            ({name} on {host}, opens in a new tab)
          </span>
        </a>
      )}
    </div>
  );
}

/**
 * What the donor did on peer instances, as each peer reports it. Set apart from everything
 * above on purpose (no card, a dashed edge): these figures are not this instance's evidence
 * and never enter its totals or its ranking.
 */
function Elsewhere({ donor }: { donor: Donor }) {
  const standings = donor.elsewhere ?? [];
  if (standings.length === 0) return null;
  return (
    <section aria-labelledby="profile-elsewhere" className="grid min-w-0 gap-3 pt-4">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="profile-elsewhere" className="text-base font-semibold tracking-tight">
            On other instances
          </h2>
          <p className="text-xs font-medium text-muted-foreground">Not counted in the totals or rank here</p>
        </div>
        <p className="max-w-prose text-sm text-pretty text-muted-foreground">
          Work {donor.handle} did on peer instances with this account. Each row is that instance's own report; this
          instance did not verify it.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-dashed">
        <Table aria-label={`What ${donor.handle} did on other instances`}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Instance</TableHead>
              <TableHead className="text-right sm:w-28">Delivered</TableHead>
              <TableHead className="text-right sm:w-28">Merged</TableHead>
              <TableHead className="pr-4 text-right sm:w-28">Tasks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {standings.map((standing) => (
              <TableRow key={standing.instance.host} className="hover:bg-muted/40">
                {/* The host is the point of this row, so it wraps on a phone instead of being cut. */}
                <TableHead scope="row" className="h-auto py-2.5 pl-4 font-normal whitespace-normal">
                  <a
                    href={standing.profile_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    <span>{standing.instance.name}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
                    <span className="sr-only">(profile on {standing.instance.host}, opens in a new tab)</span>
                  </a>
                  <span className="block text-xs text-muted-foreground">
                    as reported by <span className="num [overflow-wrap:anywhere]">{standing.instance.host}</span> · <Time value={standing.fetched_at} />
                  </span>
                </TableHead>
                <TableCell className="text-right font-medium">
                  <Num value={standing.delivered} />
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  <Num value={standing.merged} />
                </TableCell>
                <TableCell className="pr-4 text-right text-muted-foreground">
                  <span title={`${standing.tasks_delivered} delivered, ${standing.tasks_merged} merged`}>
                    <Num value={standing.tasks_delivered} unit="" />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function ProfileBody({ donor }: { donor: Donor }) {
  const meta = useMeta();
  const cardRef = useRef<HTMLElement>(null);
  const { state, download } = useDownloadCard(cardRef, donor.handle);
  const largest = Math.max(1, ...donor.projects.map((project) => project.delivered));
  const home = splitHandle(donor.handle).host;
  // A remote donor's `id` is their profile at home; the link to copy is this page.
  const link = home && meta.data ? `${meta.data.base_url.replace(/\/+$/, '')}${profilePath(donor.handle)}` : home ? window.location.href : donor.id;

  return (
    <>
      <ShareCard donor={donor} instance={meta.data?.name ?? APP_NAME} cardRef={cardRef} />
      {home && <HomeInstance donor={donor} host={home} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {home ? 'Here since' : 'Joined'} {formatDate(donor.joined_at)}
          {donor.github_login && (
            <>
              {' · '}
              <a href={`https://github.com/${donor.github_login}`} rel="noreferrer" className="link">
                github.com/{donor.github_login}
              </a>
            </>
          )}
          {' · '}
          <Num value={donor.merged} /> merged of <Num value={donor.delivered} /> delivered
        </p>
        <div className="flex items-center gap-2">
          {state === 'failed' && (
            <span role="status" className="text-xs text-muted-foreground">
              Couldn't render the image. A screenshot works too.
            </span>
          )}
          <Button size="sm" onClick={() => void download()} busy={state === 'working'} busyLabel="Rendering…">
            <Download strokeWidth={1.5} aria-hidden="true" />
            Download PNG
          </Button>
          <CopyButton text={link} label="the link to this profile" caption="Copy link" />
        </div>
      </div>

      <section aria-labelledby="profile-projects" className="grid min-w-0 gap-3 pt-4">
        <h2 id="profile-projects" className="text-base font-semibold tracking-tight">
          Projects backed
        </h2>
        {donor.projects.length === 0 ? (
          <EmptyState icon={FolderGit2} title="No projects backed yet" action={<Button asChild variant="primary"><Link to="/">Find a project</Link></Button>}>
            <p>
              {home
                ? `${donor.handle} can work here through ${home} but has not pledged or delivered anything so far.`
                : `${donor.handle} has an account here but has not pledged or delivered anything so far.`}
            </p>
          </EmptyState>
        ) : (
          <div className="surface overflow-hidden">
            <Table aria-label={`Projects backed by ${donor.handle}`}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Project</TableHead>
                  <TableHead className="hidden w-2/5 sm:table-cell">
                    <span className="sr-only">Share of delivered tokens</span>
                  </TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Merged</TableHead>
                  <TableHead className="pr-4 text-right">Pledged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {donor.projects.map((project) => (
                  <TableRow key={project.slug} className="hover:bg-muted/40">
                    <TableHead scope="row" className="h-auto py-2.5 pl-4 font-normal">
                      <Link to={`/${project.slug}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                        {project.name}
                      </Link>
                    </TableHead>
                    <TableCell className="hidden sm:table-cell">
                      <span className="block h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <span className="block h-full rounded-full bg-foreground" style={{ width: `${(project.delivered / largest) * 100}%` }} />
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <Num value={project.delivered} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      <Num value={project.merged} />
                    </TableCell>
                    <TableCell className="pr-4 text-right text-muted-foreground">
                      <Num value={project.pledged} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <Elsewhere donor={donor} />

      <section aria-labelledby="profile-recent" className="grid min-w-0 gap-3 pt-4">
        <h2 id="profile-recent" className="text-base font-semibold tracking-tight">
          Recent runs
        </h2>
        {donor.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs reported yet.</p>
        ) : (
          <ol className="surface divide-y px-4">
            {donor.recent.map((entry) => {
              const counted = entry.type === 'delivery' || entry.type === 'merge';
              return (
                <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 text-sm">
                  <p className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="text-muted-foreground">{ENTRY_VERBS[entry.type]}</span>{' '}
                    {entry.task_id && entry.project && (
                      <Link to={`/${entry.project}/tasks/${manifestId(entry.task_id)}`} className="font-medium underline-offset-4 hover:underline">
                        {entry.task_title ?? manifestId(entry.task_id)}
                      </Link>
                    )}
                    {entry.project && (
                      <>
                        <span className="text-muted-foreground"> in </span>
                        <Link to={`/${entry.project}`} className="underline-offset-4 hover:underline">
                          {entry.project}
                        </Link>
                      </>
                    )}
                    {entry.pr_url && /^https?:/.test(entry.pr_url) && (
                      <>
                        {' '}
                        <a href={entry.pr_url} rel="noreferrer" className="link num text-xs text-muted-foreground">
                          {pullRequestLabel(entry.pr_url)}
                        </a>
                      </>
                    )}
                  </p>
                  <p className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                    <Num value={entry.tokens} className={cn(counted && 'font-medium text-foreground')} />
                    <Time value={entry.at} />
                  </p>
                </li>
              );
            })}
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
    <section className="container-page grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-4 py-8">
      <h1 className="sr-only">
        {handle}: {donor.data ? `${formatCompact(donor.data.delivered)} tokens delivered` : 'donor profile'}
      </h1>
      {donor.isPending ? (
        <Loading label="donor profile" className="grid gap-4">
          <Skeleton className="aspect-[4/5] h-auto rounded-2xl sm:aspect-[1.91/1]" />
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
