import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useOutletContext, useParams } from 'react-router';
import { ApiError } from '@/api/client';
import { queryKeys, useLedger, useProject } from '@/api/queries';
import type { AuditEvent, Project, TaskCounts, Totals } from '@/api/types';
import { BackDialog } from '@/components/BackDialog';
import { Button } from '@/components/Button';
import { useCopy } from '@/components/CopyButton';
import { DailyBars } from '@/components/DailyBars';
import { FundingBar } from '@/components/FundingBar';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Num } from '@/components/Num';
import { ErrorState, Loading, Notice, Skeleton, SkeletonRows } from '@/components/States';
import { Tabs } from '@/components/Tabs';
import { TokenCounter } from '@/components/TokenCounter';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { UserLink } from '@/components/UserLink';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useLive } from '@/hooks/useLive';
import { formatCompact, formatExact, formatPercent } from '@/lib/format';
import { dailySeries } from '@/lib/series';
import { cn } from '@/lib/utils';
import NotFound from '../NotFound';

export interface ProjectContext {
  project: Project;
  /** Events received over the live stream since the page opened, newest first. */
  liveEvents: AuditEvent[];
}

export function useProjectContext(): ProjectContext {
  return useOutletContext<ProjectContext>();
}

const STATUS_NOTES: Partial<Record<Project['status'], { label: string; note: string }>> = {
  paused: { label: 'Paused', note: 'The maintainer has paused this project. Workers will not claim its tasks until it resumes.' },
  pending: { label: 'Pending approval', note: 'An instance admin has to approve this project before it is listed and claimable.' },
  removed: { label: 'Removed', note: 'This project was removed from the instance. Its ledger and audit log remain readable.' },
};

const CHART_DAYS = 30;
const stagger = (index: number) => ({ '--i': index }) as CSSProperties;

function Repo({ url }: { url: string }) {
  const label = url.replace(/^[a-z]+:\/\//, '').replace(/\.git$/, '');
  // Only web URLs are worth a link; a local path is shown as text.
  return /^https?:\/\//.test(url) ? (
    <a href={url} rel="noreferrer" className="num inline-flex min-w-0 items-center gap-1 transition-colors hover:text-foreground">
      <span className="max-w-72 truncate" title={label}>
        {label}
      </span>
      <ArrowUpRight className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
    </a>
  ) : (
    <span className="num max-w-72 truncate" title={label}>
      {label}
    </span>
  );
}

function ShareButton() {
  const { copied, copy } = useCopy(typeof window === 'undefined' ? '' : window.location.href);
  return (
    <Button size="lg" onClick={() => void copy()} className="rounded-none">
      {copied ? 'Link copied' : 'Share'}
    </Button>
  );
}

function Header({ project, running, onBack }: { project: Project; running: boolean; onBack: () => void }) {
  const status = STATUS_NOTES[project.status];
  const established = project.trust.tier === 'established';
  return (
    <header className="rise flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
      <div className="grid min-w-0 gap-3.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.045em] [overflow-wrap:anywhere]">
            {project.name}
          </h1>
          {running && (
            <span className="flex h-6 items-center gap-1.5 bg-pass-tint px-2 text-xs font-medium text-live">
              <span className="live-dot size-1.5" aria-hidden="true" />
              Running now
            </span>
          )}
          {status && <span className="flex h-6 items-center border px-2 text-xs font-medium text-muted-foreground">{status.label}</span>}
        </div>
        <p className="max-w-2xl text-[1.0625rem] leading-relaxed text-pretty text-muted-foreground">{project.description}</p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8125rem] text-muted-foreground">
          <UserLink handle={project.maintainer.handle} className="num text-foreground" />
          <Repo url={project.repo_url} />
          {project.language && <span className="num">{project.language}</span>}
          <span
            className="num"
            title={`${project.trust.merged_tasks} merged tasks. Computed from the ledger.`}
          >
            {established ? 'established' : 'new project'}
          </span>
          {(project.tags?.length ?? 0) > 0 && (
            <ul aria-label="Tags" className="flex flex-wrap gap-1">
              {project.tags?.map((tag) => (
                <li key={tag} className="num bg-muted px-1.5 py-0.5 text-[0.6875rem]">
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex w-full gap-2.5 sm:w-auto">
        <ShareButton />
        <Button variant="primary" size="lg" onClick={onBack} disabled={project.status === 'removed'} className="flex-1 rounded-none px-5 sm:flex-none">
          Back this project
        </Button>
      </div>
    </header>
  );
}

function Key({ swatch, label, value, accent }: { swatch: string; label: string; value: number; accent?: boolean }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <dt className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
        <span className={cn('size-2.5 shrink-0 rounded-full', swatch)} aria-hidden="true" />
        {label}
      </dt>
      <dd>
        <Num value={Math.max(0, value)} className={cn('text-[1.375rem] leading-7 font-medium tracking-[-0.03em]', accent && 'text-live')} />
      </dd>
    </div>
  );
}

/** The ledger panel: delivered tokens as a live counter, progress to the goal, and the trend. */
function Balance({ project, totals, status }: { project: Project; totals: Totals; status: ReturnType<typeof useLive>['status'] }) {
  const ledger = useLedger(project.slug);
  const deliveries = (ledger.data?.pages[0]?.entries ?? []).filter((entry) => entry.type === 'delivery');
  const series = dailySeries(deliveries.map((entry) => ({ at: entry.at, tokens: entry.tokens })), CHART_DAYS);
  const recent = series.reduce((sum, value) => sum + value, 0);
  const commitUrl = project.commit_url ?? (/^https?:\/\//.test(project.repo_url) ? `${project.repo_url.replace(/\.git$/, '')}/commit/${project.pinned_commit}` : null);

  return (
    <section aria-label="Funding" className="rise grid border-t border-b border-t-foreground lg:grid-cols-[minmax(0,1fr)_25rem]" style={stagger(1)}>
      <div className="grid min-w-0 gap-6 py-7 lg:border-r lg:pr-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-semibold tracking-[0.12em] uppercase">Delivered</p>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <LiveIndicator status={status} className="h-5 border-0 bg-transparent px-0" />
            {totals.in_flight > 0 && (
              <span className="num">
                · <Num value={totals.in_flight} exact /> in flight
              </span>
            )}
          </span>
        </div>
        <p className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <TokenCounter value={totals.delivered} label="tokens delivered" size="xl" />
          <span className="num text-[0.9375rem] text-muted-foreground">
            of {formatExact(project.token_goal)} goal · <span className="font-semibold text-foreground">{formatPercent(totals.delivered, project.token_goal)}</span>
          </span>
        </p>
        <FundingBar totals={totals} goal={project.token_goal} size="lg" />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
          <Key swatch="bg-foreground" label="Merged" value={totals.merged} />
          <Key swatch="bg-pass" label="Delivered, awaiting merge" value={totals.delivered - totals.merged} accent />
          <Key swatch="bg-muted-foreground" label="Reported, not delivered" value={totals.reported - totals.delivered} />
          <Key swatch="border-[1.5px] border-input" label="Pledged" value={totals.pledged} />
        </dl>
      </div>
      <div className="flex flex-col justify-between gap-6 border-t py-7 lg:border-t-0 lg:pl-10">
        <div className="grid gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[0.8125rem] text-muted-foreground">Delivered per day, last {CHART_DAYS} days</h2>
            <span className="num text-[0.8125rem] font-semibold">{ledger.isSuccess ? formatCompact(recent) : ' '}</span>
          </div>
          <DailyBars values={series} className="h-24" label={`Delivery over the last ${CHART_DAYS} days: ${formatCompact(recent)} tokens`} />
        </div>
        <dl className="grid text-[0.8125rem]">
          {[
            ['Donors', <Num key="d" value={project.donors} unit="" />],
            ['Claimable tasks', <Num key="c" value={project.tasks.claimable ?? 0} unit="" />],
            [
              'Pinned commit',
              commitUrl ? (
                <a key="p" href={commitUrl} rel="noreferrer" className="num inline-flex items-center gap-1 hover:underline">
                  {project.pinned_commit.slice(0, 7)} <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                </a>
              ) : (
                <span key="p" className="num">
                  {project.pinned_commit.slice(0, 7)}
                </span>
              ),
            ],
          ].map(([label, value]) => (
            <div key={String(label)} className="flex items-baseline justify-between gap-3 border-t py-2.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ProjectView({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [backing, setBacking] = useState(false);
  const [liveEvents, setLiveEvents] = useState<AuditEvent[]>([]);
  const refresh = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { slug } = project;

  // Events arrive in bursts (report, CI result, delivery); refetch once after each burst.
  const onEvent = useCallback(
    (event: AuditEvent) => {
      setLiveEvents((current) => [event, ...current].slice(0, 200));
      clearTimeout(refresh.current);
      refresh.current = setTimeout(() => void queryClient.invalidateQueries({ queryKey: queryKeys.project(slug) }), 600);
    },
    [queryClient, slug],
  );
  useEffect(() => () => clearTimeout(refresh.current), []);

  const live = useLive(slug, onEvent);
  const totals = live.frame?.totals ?? project.totals;
  const counts: TaskCounts = live.frame?.tasks ?? project.tasks;
  const status = STATUS_NOTES[project.status];
  const taskCount = counts.open + counts.claimed + counts.delivered + counts.merged + counts.failed;

  return (
    <div className="container-page grid grid-cols-[minmax(0,1fr)] gap-8 py-8 sm:py-10">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/">Projects</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{project.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Header project={project} running={totals.in_flight > 0} onBack={() => setBacking(true)} />
      {status && <Notice tone="strong">{status.note}</Notice>}
      <Balance project={project} totals={totals} status={live.status} />

      <div className="rise grid grid-cols-[minmax(0,1fr)] gap-6 pt-4" style={stagger(2)}>
        <Tabs
          label="Project sections"
          items={[
            { to: `/${slug}`, label: 'Tasks', count: taskCount, end: true },
            { to: `/${slug}/activity`, label: 'Activity' },
            { to: `/${slug}/donors`, label: 'Donors', count: project.donors },
            { to: `/${slug}/audit`, label: 'Audit' },
          ]}
        />
        <Outlet context={{ project, liveEvents } satisfies ProjectContext} />
      </div>

      {backing && <BackDialog project={project} onClose={() => setBacking(false)} />}
    </div>
  );
}

/** Mirrors the loaded layout box for box, so nothing jumps when the project arrives. */
function ProjectSkeleton() {
  return (
    <Loading label="project" className="container-page grid gap-6 py-6 sm:py-8">
      <Skeleton className="h-5 w-32" />
      <div className="flex gap-4">
        <Skeleton className="hidden size-12 rounded-xl sm:block" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-5 w-full max-w-md" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </div>
      </div>
      <div className="surface grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid gap-5 p-5 sm:p-6">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-14 w-80 max-w-full" />
          <Skeleton className="h-5 w-64 max-w-full" />
          <Skeleton className="h-2.5" />
          <Skeleton className="h-14" />
        </div>
        <div className="grid gap-5 border-t p-5 sm:p-6 lg:border-t-0 lg:border-l">
          <Skeleton className="h-28" />
          <Skeleton className="h-16" />
        </div>
      </div>
      <SkeletonRows rows={3} className="h-16" />
    </Loading>
  );
}

export default function ProjectPage() {
  const { slug = '' } = useParams();
  const project = useProject(slug);
  useDocumentTitle(project.data?.name ?? slug);

  if (project.isPending) return <ProjectSkeleton />;
  if (project.isError) {
    if (project.error instanceof ApiError && project.error.status === 404) {
      return <NotFound what={`a project called “${slug}”`} />;
    }
    return (
      <div className="container-page py-10">
        <ErrorState title="Couldn't load this project" error={project.error} onRetry={() => void project.refetch()} />
      </div>
    );
  }
  // Keyed by slug so live state from one project never leaks into the next.
  return <ProjectView key={project.data.slug} project={project.data} />;
}
