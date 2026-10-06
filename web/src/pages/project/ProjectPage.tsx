import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, ShieldCheck, Sprout, Zap } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useOutletContext, useParams } from 'react-router';
import { ApiError } from '@/api/client';
import { queryKeys, useLedger, useProject } from '@/api/queries';
import type { AuditEvent, Project, TaskCounts, Totals } from '@/api/types';
import { BackDialog } from '@/components/BackDialog';
import { Button } from '@/components/Button';
import { FundingBar } from '@/components/FundingBar';
import { InFlight } from '@/components/InFlight';
import { LiveIndicator } from '@/components/LiveIndicator';
import { Num } from '@/components/Num';
import { Sparkline } from '@/components/Sparkline';
import { Stat } from '@/components/Stat';
import { ErrorState, Loading, Notice, Skeleton, SkeletonRows } from '@/components/States';
import { Tabs } from '@/components/Tabs';
import { TokenCounter } from '@/components/TokenCounter';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { UserLink } from '@/components/UserLink';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useLive } from '@/hooks/useLive';
import { formatCompact, formatExact, formatPercent } from '@/lib/format';
import { cumulative, dailySeries } from '@/lib/series';
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
  const content = (
    <>
      <GitBranch className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <span className="num max-w-72 truncate text-[0.8125rem]" title={label}>
        {label}
      </span>
    </>
  );
  // Only web URLs are worth a link; a local path is shown as text.
  return /^https?:\/\//.test(url) ? (
    <a href={url} rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground">
      {content}
    </a>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1.5">{content}</span>
  );
}

function Header({ project, onBack }: { project: Project; onBack: () => void }) {
  const status = STATUS_NOTES[project.status];
  const established = project.trust.tier === 'established';
  const Tier = established ? ShieldCheck : Sprout;
  return (
    <header className="rise flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
      <div className="flex min-w-0 gap-4">
        <span
          aria-hidden="true"
          className="num hidden size-12 shrink-0 items-center justify-center rounded-xl border bg-card text-lg font-semibold uppercase shadow-card sm:flex"
        >
          {project.name.charAt(0)}
        </span>
        <div className="grid min-w-0 gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{project.name}</h1>
            <Badge variant="outline" className="gap-1" title={`${project.trust.merged_tasks} merged tasks. Computed from the ledger.`}>
              <Tier className="size-3" strokeWidth={1.75} aria-hidden="true" />
              {established ? 'Established' : 'New project'}
            </Badge>
            {status && <Badge variant="secondary">{status.label}</Badge>}
          </div>
          <p className="max-w-2xl text-[0.9375rem] text-pretty text-muted-foreground">{project.description}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
            <Repo url={project.repo_url} />
            {project.language && <span className="font-medium text-foreground">{project.language}</span>}
            {project.tags?.map((tag) => <span key={tag}>{tag}</span>)}
            <span className="inline-flex items-center gap-1.5">
              by <UserLink handle={project.maintainer.handle} avatar className="text-foreground" />
            </span>
          </div>
        </div>
      </div>
      <Button variant="primary" size="lg" onClick={onBack} disabled={project.status === 'removed'} className="w-full sm:w-auto">
        <Zap className="fill-current" strokeWidth={0} aria-hidden="true" />
        Back with tokens
      </Button>
    </header>
  );
}

/** The balance panel: delivered tokens as a live counter, progress to the goal, and the trend. */
function Balance({ project, totals, status }: { project: Project; totals: Totals; status: ReturnType<typeof useLive>['status'] }) {
  const ledger = useLedger(project.slug);
  const deliveries = (ledger.data?.pages[0]?.entries ?? []).filter((entry) => entry.type === 'delivery');
  const series = dailySeries(deliveries.map((entry) => ({ at: entry.at, tokens: entry.tokens })), CHART_DAYS);
  const recent = series.reduce((sum, value) => sum + value, 0);

  return (
    <section aria-label="Funding" className="surface rise grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_20rem]" style={stagger(1)}>
      <div className="grid min-w-0 gap-5 p-5 sm:p-6">
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="label">Tokens delivered</p>
            <LiveIndicator status={status} />
          </div>
          <p className="mt-3 -ml-[0.03em]">
            <TokenCounter value={totals.delivered} label="tokens delivered" size="xl" />
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            of a <span className="num text-foreground">{formatExact(project.token_goal)}</span> token goal ·{' '}
            <span className="num text-foreground">{formatPercent(totals.delivered, project.token_goal)}</span>
          </p>
          <InFlight tokens={totals.in_flight} className="mt-3" />
        </div>
        <FundingBar totals={totals} goal={project.token_goal} size="lg" />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
          <Stat label="Pledged" swatch="bg-foreground/15 ring-1 ring-border" value={<Num value={totals.pledged} />} note="Stated intent" />
          <Stat label="Delivered" swatch="bg-live" value={<Num value={totals.delivered} />} note="CI passed" />
          <Stat label="Merged" swatch="bg-foreground" value={<Num value={totals.merged} />} note="PR merged" />
          <Stat label="Reported" value={<Num value={totals.reported} />} note="Includes failed runs" />
        </dl>
      </div>
      <div className="flex flex-col gap-5 border-t bg-muted/30 p-5 sm:p-6 lg:border-t-0 lg:border-l">
        <div className="flex min-h-32 flex-1 flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="label">Delivered, last {CHART_DAYS} days</h2>
            <span className="num text-sm font-medium">{ledger.isSuccess ? formatCompact(recent) : ' '}</span>
          </div>
          <Sparkline
            values={cumulative(series)}
            className="h-auto min-h-20 flex-1 text-foreground"
            label={`Delivery over the last ${CHART_DAYS} days: ${formatCompact(recent)} tokens`}
          />
        </div>
        <dl className="grid gap-2.5 text-sm">
          {[
            ['Donors', <Num key="d" value={project.donors} unit="" />],
            ['Claimable tasks', <Num key="c" value={project.tasks.claimable ?? 0} unit="" />],
            ['7-day delivery', <Num key="v" value={project.velocity_7d} />],
          ].map(([label, value]) => (
            <div key={String(label)} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
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
    <div className="container-page grid grid-cols-[minmax(0,1fr)] gap-6 py-6 sm:py-8">
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

      <Header project={project} onBack={() => setBacking(true)} />
      {status && <Notice tone="strong">{status.note}</Notice>}
      <Balance project={project} totals={totals} status={live.status} />

      <div className="rise grid grid-cols-[minmax(0,1fr)] gap-6" style={stagger(2)}>
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
