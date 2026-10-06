import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useOutletContext, useParams } from 'react-router';
import { ApiError } from '../../api/client';
import { queryKeys, useProject } from '../../api/queries';
import type { AuditEvent, Project, TaskCounts, Totals } from '../../api/types';
import { BackDialog } from '../../components/BackDialog';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { FundingBar } from '../../components/FundingBar';
import { LiveIndicator } from '../../components/LiveIndicator';
import { Num } from '../../components/Num';
import { ErrorState, Loading, Notice, Skeleton, SkeletonRows } from '../../components/States';
import { StatList } from '../../components/StatList';
import { Tabs } from '../../components/Tabs';
import { TokenCounter } from '../../components/TokenCounter';
import { UserLink } from '../../components/UserLink';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useLive } from '../../hooks/useLive';
import { formatExact, formatPercent } from '../../lib/format';
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

function repoLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

function Funding({ project, totals, onBack }: { project: Project; totals: Totals; onBack: () => void }) {
  const running = totals.in_flight > 0;
  return (
    <section className="funding" aria-label="Funding">
      <div className="funding__main">
        <p className="funding__counter">
          <TokenCounter value={totals.delivered} label="tokens delivered" size="xl" />
        </p>
        <p className="funding__goal">
          delivered of a <span className="mono">{formatExact(project.token_goal)}</span> token goal ·{' '}
          <span className="mono">{formatPercent(totals.delivered, project.token_goal)}</span>
        </p>
        <p className="in-flight" data-active={running || undefined}>
          {running ? (
            <>
              <span className="live-dot" aria-hidden="true" />
              <span>Running now</span>
              <TokenCounter value={totals.in_flight} label="tokens in flight" size="md" tone="accent" />
            </>
          ) : (
            <span className="muted">No worker is running right now.</span>
          )}
        </p>
        <FundingBar totals={totals} goal={project.token_goal} size="lg" />
        <StatList
          stats={[
            { label: 'Pledged', swatch: 'pledged', value: <Num value={totals.pledged} /> },
            { label: 'Delivered', swatch: 'delivered', value: <Num value={totals.delivered} />, note: 'CI passed' },
            { label: 'Merged', swatch: 'merged', value: <Num value={totals.merged} />, note: 'PR merged' },
            { label: 'Reported', value: <Num value={totals.reported} />, note: 'includes failed runs' },
          ]}
        />
      </div>
      <div className="funding__aside">
        <Button variant="primary" size="lg" onClick={onBack} disabled={project.status === 'removed'}>
          <span aria-hidden="true">⚡ </span>Back with tokens
        </Button>
        <p className="muted">Runs on your machine, under your own Claude Code login. No money changes hands.</p>
        <StatList
          stats={[
            { label: 'Donors', value: <Num value={project.donors} unit="" /> },
            { label: 'Claimable tasks', value: <Num value={project.tasks.claimable ?? 0} unit="" /> },
            { label: '7-day delivery', value: <Num value={project.velocity_7d} /> },
          ]}
        />
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
    <div className="page project">
      <header className="project__header">
        <div className="project__title">
          <h1>{project.name}</h1>
          {status && <Badge tone="strong">{status.label}</Badge>}
          <LiveIndicator status={live.status} />
        </div>
        <p className="lede">{project.description}</p>
        <ul className="meta-list">
          <li>
            <a href={project.repo_url} rel="noreferrer" className="mono">
              {repoLabel(project.repo_url)}
            </a>
          </li>
          {project.language && <li>{project.language}</li>}
          {project.tags?.map((tag) => <li key={tag}>{tag}</li>)}
          <li>
            Maintained by <UserLink handle={project.maintainer.handle} />
          </li>
        </ul>
      </header>

      {status && <Notice tone="strong">{status.note}</Notice>}

      <Funding project={project} totals={totals} onBack={() => setBacking(true)} />

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

      {backing && <BackDialog project={project} onClose={() => setBacking(false)} />}
    </div>
  );
}

function ProjectSkeleton() {
  return (
    <div className="page project">
      <Loading label="project">
        <header className="project__header">
          <Skeleton width="14rem" height="2.75rem" />
          <Skeleton width="min(28rem, 100%)" height="1.6rem" />
          <Skeleton width="min(20rem, 80%)" height="1.3rem" />
        </header>
        <div className="funding">
          <div className="funding__main">
            <Skeleton width="min(22rem, 100%)" height="3.4rem" />
            <Skeleton width="16rem" height="1.4rem" />
            <Skeleton width="12rem" height="1.5rem" />
            <Skeleton height="0.75rem" />
            <Skeleton width="min(26rem, 100%)" height="3.2rem" />
          </div>
          <div className="funding__aside">
            <Skeleton height="3rem" />
            <Skeleton height="4rem" />
          </div>
        </div>
        <SkeletonRows rows={4} />
      </Loading>
    </div>
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
      <div className="page">
        <ErrorState title="Couldn't load this project" error={project.error} onRetry={() => void project.refetch()} />
      </div>
    );
  }
  // Keyed by slug so live state from one project never leaks into the next.
  return <ProjectView key={project.data.slug} project={project.data} />;
}
