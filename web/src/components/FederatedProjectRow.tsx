import { ArrowUpRight } from 'lucide-react';
import type { FederatedProject } from '@/api/types';
import { formatCompact } from '@/lib/format';
import { cn } from '@/lib/utils';
import { InstanceBadge } from './InstanceBadge';
import { Num } from './Num';
import { Skeleton } from './States';

function Status({ project }: { project: FederatedProject }) {
  const chip = 'inline-flex h-5 items-center px-1.5 text-[0.6875rem] font-medium whitespace-nowrap';
  if (project.token_goal > 0 && project.totals.delivered >= project.token_goal) return <span className={cn(chip, 'bg-pass font-semibold text-black')}>Funded</span>;
  if (project.status === 'paused') return <span className={cn(chip, 'border text-muted-foreground')}>Paused</span>;
  if ((project.tasks.claimable ?? project.tasks.open) > 0) return <span className={cn(chip, 'border border-foreground')}>Needs donors</span>;
  return null;
}

interface FederatedProjectRowProps {
  project: FederatedProject;
  /** Open the instructions for backing this project from an account on this instance. */
  onBack: () => void;
  /** The column template of the list the row sits in. */
  className?: string;
}

/**
 * A project hosted on a peer instance, as a ledger row. It reads like a local row, with three
 * differences that say "this lives elsewhere": the home instance's host sits next to the name,
 * the row opens that instance in a new tab (an arrow stands where a local row has its rank),
 * and there is no 7-day figure, because the delivery ledger is not here. The numbers are the
 * peer's own, as of the last sync.
 */
export function FederatedProjectRow({ project, onBack, className }: FederatedProjectRowProps) {
  const { totals, token_goal: goal, instance } = project;
  const percent = goal > 0 ? Math.round((totals.delivered / goal) * 100) : 0;
  const open = project.tasks.claimable ?? project.tasks.open;
  return (
    <li className={cn('group relative grid gap-3 border-b py-5 transition-colors hover:bg-muted/40', className)}>
      <ArrowUpRight
        className="hidden size-4 text-muted-foreground transition-colors group-hover:text-foreground md:block"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h3 className="min-w-0 text-base font-semibold tracking-tight">
            {/* The whole row is the link target; it leaves this instance, so it opens a new tab. */}
            <a href={project.url} target="_blank" rel="noreferrer" className="after:absolute after:inset-0 focus-visible:outline-none">
              {project.name}
              <span className="sr-only"> on {instance.host} (opens in a new tab)</span>
            </a>
          </h3>
          <InstanceBadge instance={instance} />
          <Status project={project} />
        </div>
        <p className="truncate text-[0.8125rem] text-muted-foreground">{project.description}</p>
        {(project.tags?.length ?? 0) > 0 && (
          <ul aria-label="Tags" className="flex flex-wrap gap-1 pt-1">
            {project.tags?.slice(0, 4).map((tag) => (
              <li key={tag} className="num bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                {tag}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="hidden text-[0.8125rem] md:block">{project.language ?? '—'}</span>
      <div className="grid gap-2">
        <div
          role="img"
          aria-label={`${formatCompact(totals.delivered)} delivered of a ${goal > 0 ? formatCompact(goal) : 'open'} token goal`}
          className="h-1 w-full bg-muted"
        >
          <div className="h-1 bg-pass" style={{ width: `${Math.min(percent, 100)}%` }} />
        </div>
        <div className="flex justify-between gap-3 text-xs">
          <span>
            <Num value={totals.delivered} /> <span className="num text-muted-foreground">of {goal > 0 ? formatCompact(goal) : '—'}</span>
          </span>
          <span className="num font-semibold">{goal > 0 ? `${percent}%` : ''}</span>
        </div>
      </div>
      <div className="flex justify-between text-xs md:contents">
        <span className="text-muted-foreground md:hidden">Open tasks</span>
        <span className={cn('num md:text-right md:text-[0.8125rem]', open === 0 && 'text-muted-foreground')}>{open > 0 ? open : '—'}</span>
      </div>
      <div className="flex justify-between text-xs md:contents">
        <span className="text-muted-foreground md:hidden">Donors</span>
        <span className="num md:text-right md:text-[0.8125rem]">{project.donors}</span>
      </div>
      {/* Above the row-wide link, so it stays a control of its own. */}
      <button
        type="button"
        onClick={onBack}
        aria-label={`How to back ${project.name} on ${instance.host}`}
        className="relative z-10 flex h-9 items-center justify-center border border-foreground bg-background text-[0.8125rem] font-medium whitespace-nowrap transition-colors hover:bg-foreground hover:text-background md:h-8"
      >
        How to back
      </button>
    </li>
  );
}

/** Same lines as a loaded row, so nothing moves when data arrives. */
export function FederatedProjectRowSkeleton() {
  return (
    <div className="grid gap-2 border-b py-5" aria-hidden="true">
      <Skeleton className="h-5 w-56 max-w-full" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}
