import { useRef } from 'react';
import { Link } from 'react-router';
import { useLedger } from '@/api/queries';
import type { Project } from '@/api/types';
import { useInView } from '@/hooks/useInView';
import { formatCompact, formatPercent } from '@/lib/format';
import { cumulative, dailySeries } from '@/lib/series';
import { FundingBar } from './FundingBar';
import { Num } from './Num';
import { Sparkline } from './Sparkline';
import { Skeleton } from './States';

const DAYS = 30;

function taskSummary(tasks: Project['tasks']): string {
  const parts = [
    tasks.open > 0 && `${tasks.open} open`,
    tasks.claimed > 0 && `${tasks.claimed} in progress`,
    tasks.merged > 0 && `${tasks.merged} merged`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'No tasks yet';
}

/** Delivery per day for the card's sparkline; fetched only once the card is near the viewport. */
function Trend({ slug, visible }: { slug: string; visible: boolean }) {
  const ledger = useLedger(slug, visible);
  const deliveries = (ledger.data?.pages[0]?.entries ?? []).filter((entry) => entry.type === 'delivery');
  const series = dailySeries(deliveries.map((entry) => ({ at: entry.at, tokens: entry.tokens })), DAYS);
  const total = series.reduce((sum, value) => sum + value, 0);
  return (
    <Sparkline
      values={cumulative(series)}
      className="h-8 w-24 text-foreground"
      label={`Delivery over the last ${DAYS} days: ${formatCompact(total)} tokens`}
    />
  );
}

function Status({ project }: { project: Project }) {
  if (project.totals.in_flight > 0) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-live">
        <span className="live-dot" aria-hidden="true" /> Running now
      </span>
    );
  }
  if (project.status === 'paused') return <span className="shrink-0 text-xs font-medium text-muted-foreground">Paused</span>;
  if ((project.tasks.claimable ?? 0) > 0) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
        <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" /> Needs donors
      </span>
    );
  }
  return null;
}

export function ProjectCard({ project }: { project: Project }) {
  const { totals } = project;
  const card = useRef<HTMLElement>(null);
  const visible = useInView(card);
  return (
    <article
      ref={card}
      className="surface group relative flex min-w-0 flex-col gap-4 p-5 transition duration-200 ease-out focus-within:border-foreground/25 hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-raised"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight">
            {/* The whole card is the link target; the name carries the accessible name. */}
            <Link to={`/${project.slug}`} className="after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none">
              {project.name}
            </Link>
          </h3>
          <p className="mt-1 line-clamp-2 min-h-10 text-sm text-pretty text-muted-foreground">{project.description}</p>
        </div>
        <Status project={project} />
      </header>

      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="num text-2xl leading-none font-medium tracking-tight">
            <Num value={totals.delivered} />
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            delivered · <span className="num">{formatPercent(totals.delivered, project.token_goal)}</span> of{' '}
            <Num value={project.token_goal} />
          </p>
        </div>
        <Trend slug={project.slug} visible={visible} />
      </div>

      <FundingBar totals={totals} goal={project.token_goal} />

      <footer className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <ul aria-label="Language and tags" className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {project.language && (
            <li className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-medium text-foreground">{project.language}</li>
          )}
          {project.tags?.slice(0, 1).map((tag) => (
            <li key={tag} className="rounded-md border px-1.5 py-0.5 whitespace-nowrap">
              {tag}
            </li>
          ))}
        </ul>
        <p className="shrink-0 whitespace-nowrap">{taskSummary(project.tasks)}</p>
      </footer>
    </article>
  );
}

/** Same boxes as a loaded card, so nothing moves when data arrives. */
export function ProjectCardSkeleton() {
  return (
    <div className="surface flex flex-col gap-4 p-5" aria-hidden="true">
      <div className="grid gap-2">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-10 w-4/5" />
      </div>
      <div className="flex items-end justify-between">
        <div className="grid gap-1.5">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-1.5" />
      <Skeleton className="h-[1.375rem] w-3/5" />
    </div>
  );
}
