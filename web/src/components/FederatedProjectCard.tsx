import { ArrowUpRight } from 'lucide-react';
import type { FederatedProject } from '@/api/types';
import { formatPercent } from '@/lib/format';
import { Button } from './Button';
import { FundingBar } from './FundingBar';
import { InstanceBadge } from './InstanceBadge';
import { Num } from './Num';
import { taskSummary } from './ProjectCard';
import { Skeleton } from './States';
import { Time } from './Time';

function Status({ project }: { project: FederatedProject }) {
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

interface FederatedProjectCardProps {
  project: FederatedProject;
  /** Open the instructions for backing this project from an account on this instance. */
  onBack: () => void;
}

/**
 * A project hosted on a peer instance. It reads like a local card, with three differences that
 * say "this lives elsewhere": the home instance's host leads, the card opens that instance in a
 * new tab, and there is no trend line, because the delivery ledger is not here. The figures are
 * the peer's own, as of the last sync.
 */
export function FederatedProjectCard({ project, onBack }: FederatedProjectCardProps) {
  const { totals, instance } = project;
  return (
    <article className="surface group relative flex min-w-0 flex-col gap-4 p-5 transition duration-200 ease-out focus-within:border-foreground/25 hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-raised">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <p className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <InstanceBadge instance={instance} />
          <span className="shrink-0 whitespace-nowrap">
            synced <Time value={project.fetched_at} />
          </span>
        </p>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1 text-base font-semibold tracking-tight">
              {/* The whole card is the link target; it leaves this instance, so it opens a new tab. */}
              <a
                href={project.url}
                target="_blank"
                rel="noreferrer"
                className="truncate after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
              >
                {project.name}
                <span className="sr-only"> on {instance.host} (opens in a new tab)</span>
              </a>
              <ArrowUpRight
                className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </h3>
            <p className="mt-1 line-clamp-2 min-h-10 text-sm text-pretty text-muted-foreground">{project.description}</p>
          </div>
          <Status project={project} />
        </header>
      </div>

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
        {/* Above the card-wide link, so it stays a control of its own. */}
        <Button size="sm" onClick={onBack} className="relative z-10 shrink-0" aria-label={`How to back ${project.name} on ${instance.host}`}>
          How to back
        </Button>
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
export function FederatedProjectCardSkeleton() {
  return (
    <div className="surface flex flex-col gap-4 p-5" aria-hidden="true">
      <div className="grid gap-3">
        <Skeleton className="h-[1.375rem] w-2/5" />
        <div className="grid gap-2">
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-10 w-4/5" />
        </div>
      </div>
      <div className="flex items-end justify-between">
        <div className="grid gap-1.5">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-7 w-24" />
      </div>
      <Skeleton className="h-1.5" />
      <Skeleton className="h-[1.375rem] w-3/5" />
    </div>
  );
}
