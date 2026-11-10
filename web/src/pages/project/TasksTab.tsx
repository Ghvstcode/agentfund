import { Columns3, Gauge, Link2, ListChecks, LockKeyhole, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { flatItems, useTasks } from '@/api/queries';
import type { Task } from '@/api/types';
import { HandleAvatar } from '@/components/HandleAvatar';
import { TokenDot, type TokenState } from '@/components/Mark';
import { Num } from '@/components/Num';
import { EmptyState, ErrorState, Loading, Skeleton } from '@/components/States';
import { KEEP_SCROLL } from '@/components/Tabs';
import { TokenCounter } from '@/components/TokenCounter';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { useProjectContext } from './ProjectPage';
import { TaskDrawer } from './TaskDrawer';
import { BOARD_STATES, STATE_HINTS, STATE_LABELS, taskStatus } from './taskStates';

type View = 'board' | 'table';
const VIEW_KEY = 'agentfund.tasks.view';

/** Each column wears the token state its tasks are in. */
const COLUMN_DOTS: Record<(typeof BOARD_STATES)[number], TokenState> = {
  open: 'pledged',
  claimed: 'running',
  delivered: 'delivered',
  merged: 'merged',
};

function storedView(): View | null {
  try {
    const value = window.localStorage.getItem(VIEW_KEY);
    return value === 'board' || value === 'table' ? value : null;
  } catch {
    return null;
  }
}

/** Donor and streaming token count of the run in progress. */
function ClaimLine({ task }: { task: Task }) {
  const claim = task.active_claim;
  if (!claim) return null;
  const handle = claim.donor?.handle ?? 'a donor';
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-live">
      <HandleAvatar handle={handle} className="size-4 text-[0.5rem]" />
      <span className="truncate">{handle}</span>
      <TokenCounter value={claim.tokens_so_far ?? 0} label="tokens so far" size="sm" tone="accent" />
    </span>
  );
}

function Chip({ icon: Icon, children, strong }: { icon: typeof Gauge; children: React.ReactNode; strong?: boolean }) {
  return (
    <span className={cn('num inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.6875rem]', strong ? 'border border-foreground/40 text-foreground' : 'bg-muted text-muted-foreground')}>
      <Icon className="size-3" strokeWidth={1.5} aria-hidden="true" />
      {children}
    </span>
  );
}

function TaskCard({ task, slug }: { task: Task; slug: string }) {
  const status = taskStatus(task);
  return (
    <li
      className={cn(
        'relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 border bg-card px-4 py-3.5 transition-colors duration-200 focus-within:border-foreground/40 hover:border-foreground/40',
        status.live && 'border-pass bg-pass-tint hover:border-pass',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="num truncate text-[0.6875rem] text-muted-foreground">{task.task_id}</span>
        <span className={cn('flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium', status.live ? 'text-live' : 'text-muted-foreground')}>
          {status.live ? <span className="live-dot" aria-hidden="true" /> : <status.icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />}
          {status.label}
        </span>
      </div>
      <h4 className="text-[0.9375rem] leading-snug font-semibold tracking-[-0.01em] text-pretty">
        <Link to={`/${slug}/tasks/${task.task_id}`} state={KEEP_SCROLL} className="after:absolute after:inset-0 focus-visible:outline-none">
          {task.title}
        </Link>
      </h4>
      <ClaimLine task={task} />
      <div className="flex flex-wrap gap-1">
        {task.burn.runs > 0 ? (
          <Chip icon={Gauge}>
            <Num value={task.burn.total} /> burned · {task.burn.runs} {task.burn.runs === 1 ? 'run' : 'runs'}
          </Chip>
        ) : (
          <Chip icon={Gauge}>
            <Num value={task.manifest.max_tokens} /> cap
          </Chip>
        )}
        {task.depends_on.map((dependency) => {
          const blocking = task.blocked_by.includes(dependency);
          return (
            <Chip key={dependency} icon={blocking ? LockKeyhole : Link2} strong={blocking}>
              <span className="num">{dependency.slice(0, 4)}</span>
              <span className="sr-only">{blocking ? ' blocks this task' : ' is a merged dependency'}</span>
            </Chip>
          );
        })}
      </div>
    </li>
  );
}

function Board({ tasks, slug }: { tasks: Task[]; slug: string }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 xl:grid-cols-4">
      {BOARD_STATES.map((state) => {
        const column = tasks.filter((task) => task.state === state);
        return (
          <section key={state} aria-labelledby={`column-${state}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2.5">
            <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-b-foreground pb-2.5">
              <TokenDot state={COLUMN_DOTS[state]} />
              <h3 id={`column-${state}`} className="text-sm font-semibold tracking-tight">
                {STATE_LABELS[state]}
              </h3>
              <span className="num text-xs text-muted-foreground">{column.length}</span>
              {/* Wraps under the title when the column is narrow; never clipped. */}
              <span className="ml-auto text-xs text-muted-foreground">{STATE_HINTS[state]}</span>
            </header>
            {column.length === 0 ? (
              <p className="border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Nothing here</p>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                {column.map((task) => (
                  <TaskCard key={task.id} task={task} slug={slug} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TaskTable({ tasks, slug, label }: { tasks: Task[]; slug: string; label: string }) {
  return (
    <div className="surface overflow-hidden">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Task</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Cap</TableHead>
            <TableHead className="pr-4 text-right">Burn</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => {
            const status = taskStatus(task);
            return (
              <TableRow key={task.id} className="hover:bg-muted/40">
                <TableCell className="max-w-0 w-full pl-4 whitespace-normal">
                  <Link to={`/${slug}/tasks/${task.task_id}`} state={KEEP_SCROLL} className="font-medium underline-offset-4 hover:underline">
                    {task.title}
                  </Link>
                  <span className="num mt-0.5 block truncate text-xs text-muted-foreground">
                    {task.task_id}
                    {task.blocked_by.length > 0 && ` · blocked by ${task.blocked_by.join(', ')}`}
                  </span>
                </TableCell>
                <TableCell>
                  <span className={cn('flex items-center gap-1.5 text-xs font-medium', status.live ? 'text-live' : 'text-muted-foreground')}>
                    {status.live ? <span className="live-dot" aria-hidden="true" /> : <status.icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />}
                    {status.label}
                  </span>
                  {task.active_claim && (
                    <span className="mt-1 block">
                      <ClaimLine task={task} />
                    </span>
                  )}
                </TableCell>
                <TableCell className="hidden text-right text-muted-foreground sm:table-cell">
                  <Num value={task.manifest.max_tokens} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <Num value={task.burn.total} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options = [
    ['board', 'Board', Columns3],
    ['table', 'Table', Rows3],
  ] as const;
  return (
    <div role="group" aria-label="Task layout" className="inline-flex border">
      {options.map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className="flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-foreground aria-pressed:text-background"
        >
          <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

export default function TasksTab() {
  const { project } = useProjectContext();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const wide = useMediaQuery('(min-width: 48rem)');
  const [chosen, setChosen] = useState<View | null>(storedView);
  const query = useTasks(project.slug);
  const tasks = flatItems(query);
  // The board is two columns from 768px and four from 1280px; phones always get the table.
  const view: View = wide ? (chosen ?? 'board') : 'table';
  const closed = tasks.filter((task) => task.state === 'failed');
  const running = tasks.filter((task) => task.active_claim).length;

  const choose = (next: View) => {
    setChosen(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // The choice lasts for this visit only.
    }
  };

  return (
    <section aria-labelledby="tasks-title" className="grid min-w-0 gap-4">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 id="tasks-title" className="text-sm text-muted-foreground">
          <span className="sr-only">Tasks: </span>
          {query.isSuccess && (
            <>
              <span className="num font-medium text-foreground">{tasks.length}</span> signed at the pinned commit
              {running > 0 && (
                <>
                  {' · '}
                  <span className="font-medium text-live">
                    <span className="num">{running}</span> running
                  </span>
                </>
              )}
            </>
          )}
        </h2>
        {wide && <ViewToggle view={view} onChange={choose} />}
      </div>
      {query.isPending ? (
        <Loading label="tasks" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-56 rounded-none" />
          ))}
        </Loading>
      ) : query.isError ? (
        <ErrorState title="Couldn't load tasks" error={query.error} onRetry={() => void query.refetch()} />
      ) : tasks.length === 0 ? (
        <EmptyState icon={ListChecks} title="No tasks at the pinned commit">
          <p>
            The signed lock at <span className="num text-foreground">{project.pinned_commit.slice(0, 7)}</span> lists no
            task manifests. Tasks appear here when the maintainer signs a lock that includes them and the project is
            re-pinned.
          </p>
        </EmptyState>
      ) : view === 'board' ? (
        <>
          <Board tasks={tasks} slug={project.slug} />
          {closed.length > 0 && (
            <section aria-labelledby="closed-title" className="grid gap-3 pt-4">
              <div>
                <h3 id="closed-title" className="text-sm font-semibold tracking-tight">
                  Closed
                </h3>
                <p className="text-xs text-muted-foreground">Removed from the lock at a newer pin, or closed by an admin.</p>
              </div>
              <TaskTable tasks={closed} slug={project.slug} label="Closed tasks" />
            </section>
          )}
        </>
      ) : (
        <TaskTable tasks={tasks} slug={project.slug} label="Tasks" />
      )}
      {taskId && (
        <TaskDrawer slug={project.slug} manifestId={taskId} onClose={() => void navigate(`/${project.slug}`, { state: KEEP_SCROLL })} />
      )}
    </section>
  );
}
