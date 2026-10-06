import { Link, useNavigate, useParams } from 'react-router';
import { flatItems, useTasks } from '../../api/queries';
import type { Task } from '../../api/types';
import { Badge } from '../../components/Badge';
import { Num } from '../../components/Num';
import { EmptyState, ErrorState, Loading, SkeletonRows } from '../../components/States';
import { TableScroll } from '../../components/TableScroll';
import { KEEP_SCROLL } from '../../components/Tabs';
import { TokenCounter } from '../../components/TokenCounter';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useProjectContext } from './ProjectPage';
import { TaskDrawer } from './TaskDrawer';
import { BOARD_STATES, STATE_HINTS, STATE_LABELS } from './taskStates';

function ClaimLine({ task }: { task: Task }) {
  const claim = task.active_claim;
  if (!claim) {
    return task.state === 'claimed' ? <span className="claim-line claim-line--waiting">Awaiting CI</span> : null;
  }
  return (
    <span className="claim-line">
      <span className="live-dot" aria-hidden="true" />
      <span className="claim-line__donor">{claim.donor?.handle ?? 'a donor'}</span>
      <TokenCounter value={claim.tokens_so_far ?? 0} label="tokens so far" size="sm" tone="accent" />
    </span>
  );
}

function TaskCard({ task, slug }: { task: Task; slug: string }) {
  return (
    <li className="task-card">
      <p className="task-card__id mono">{task.task_id}</p>
      <h4 className="task-card__title">
        <Link to={`/${slug}/tasks/${task.task_id}`} state={KEEP_SCROLL}>
          {task.title}
        </Link>
      </h4>
      <ClaimLine task={task} />
      {task.blocked_by.length > 0 && (
        <p className="task-card__blocked">
          Blocked by <span className="mono">{task.blocked_by.join(', ')}</span>
        </p>
      )}
      <p className="task-card__burn muted">
        {task.burn.runs > 0 ? (
          <>
            <Num value={task.burn.total} /> burned · {task.burn.runs} {task.burn.runs === 1 ? 'run' : 'runs'}
          </>
        ) : (
          <>
            Cap <Num value={task.manifest.max_tokens} />
          </>
        )}
      </p>
    </li>
  );
}

function Board({ tasks, slug }: { tasks: Task[]; slug: string }) {
  return (
    <div className="board">
      {BOARD_STATES.map((state) => {
        const column = tasks.filter((task) => task.state === state);
        return (
          <section key={state} className="board__column" aria-labelledby={`column-${state}`}>
            <header className="board__header">
              <h3 id={`column-${state}`}>
                {STATE_LABELS[state]} <span className="mono muted">{column.length}</span>
              </h3>
              <p className="muted">{STATE_HINTS[state]}</p>
            </header>
            {column.length === 0 ? (
              <p className="board__empty muted">None</p>
            ) : (
              <ul className="board__cards">
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
    <TableScroll label={label}>
      <table className="table table--dense">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">State</th>
            <th scope="col" className="table__num">
              Burn
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>
                <Link to={`/${slug}/tasks/${task.task_id}`} state={KEEP_SCROLL}>
                  {task.title}
                </Link>
                <span className="table__sub mono">{task.task_id}</span>
                {task.blocked_by.length > 0 && (
                  <span className="table__sub">
                    Blocked by <span className="mono">{task.blocked_by.join(', ')}</span>
                  </span>
                )}
              </td>
              <td>
                {task.active_claim ? <Badge tone="live">Running</Badge> : STATE_LABELS[task.state]}
                {task.active_claim && (
                  <span className="table__sub">
                    <ClaimLine task={task} />
                  </span>
                )}
              </td>
              <td className="table__num">
                <Num value={task.burn.total} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export default function TasksTab() {
  const { project } = useProjectContext();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const wide = useMediaQuery('(min-width: 64rem)');
  const query = useTasks(project.slug);
  const tasks = flatItems(query);
  const closed = tasks.filter((task) => task.state === 'failed');

  return (
    <section className="tab-panel" aria-labelledby="tasks-title">
      <h2 id="tasks-title" className="sr-only">
        Tasks
      </h2>
      {query.isPending ? (
        <Loading label="tasks">
          <SkeletonRows rows={5} height="4rem" />
        </Loading>
      ) : query.isError ? (
        <ErrorState title="Couldn't load tasks" error={query.error} onRetry={() => void query.refetch()} />
      ) : tasks.length === 0 ? (
        <EmptyState title="No tasks at the pinned commit">
          <p>
            The signed lock at <span className="mono">{project.pinned_commit.slice(0, 7)}</span> lists no task
            manifests. Tasks appear here when the maintainer signs a lock that includes them and the project is
            re-pinned.
          </p>
        </EmptyState>
      ) : (
        <>
          {wide ? <Board tasks={tasks} slug={project.slug} /> : <TaskTable tasks={tasks} slug={project.slug} label="Tasks" />}
          {wide && closed.length > 0 && (
            <section className="tab-panel__section" aria-labelledby="closed-title">
              <h3 id="closed-title">Closed</h3>
              <p className="muted">Removed from the lock at a newer pin, or closed by an admin.</p>
              <TaskTable tasks={closed} slug={project.slug} label="Closed tasks" />
            </section>
          )}
        </>
      )}
      {taskId && (
        <TaskDrawer
          slug={project.slug}
          manifestId={taskId}
          onClose={() => void navigate(`/${project.slug}`, { state: KEEP_SCROLL })}
        />
      )}
    </section>
  );
}
