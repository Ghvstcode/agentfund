import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, FolderGit2, Pause, Play } from 'lucide-react';
import { type CSSProperties, type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, unwrap } from '@/api/client';
import { flatItems, queryKeys, useMe, useProjects, useTasks } from '@/api/queries';
import type { Project } from '@/api/types';
import { Button, ButtonLink } from '@/components/Button';
import { SwitchField, TextField } from '@/components/Field';
import { FundingBar } from '@/components/FundingBar';
import { Hash } from '@/components/Hash';
import { TokenDot } from '@/components/Mark';
import { Num } from '@/components/Num';
import { SignInRequired } from '@/components/SignIn';
import { describeError, EmptyState, ErrorState, Loading, Notice, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { WebhookPanel } from '@/components/WebhookPanel';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useSession } from '@/hooks/useSession';
import { formatExact, formatPercent, parseTokenAmount } from '@/lib/format';
import { pullRequestLabel } from '@/lib/prs';
import { cn } from '@/lib/utils';

const STATUS_LABELS: Record<Project['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  pending: 'Pending approval',
  removed: 'Removed',
};

function useProjectMutation<T>(slug: string, action: (input: T) => Promise<Project>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.project(slug), project);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** One setting in a project card: what it changes on the left, the control on the right. */
function Control({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 border-t py-5 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] md:gap-10">
      <div className="grid content-start gap-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-[0.8125rem] text-pretty text-muted-foreground">{note}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ManageProject({ project }: { project: Project }) {
  const { slug } = project;
  const [goal, setGoal] = useState('');
  const [goalInvalid, setGoalInvalid] = useState(false);
  const [commit, setCommit] = useState('');

  const patch = useProjectMutation(slug, (body: { status?: 'active' | 'paused'; token_goal?: number; follow_branch?: boolean }) =>
    unwrap(api.PATCH('/v1/projects/{slug}', { params: { path: { slug } }, body })),
  );
  const repin = useProjectMutation(slug, (target: string | undefined) =>
    unwrap(api.POST('/v1/projects/{slug}/repin', { params: { path: { slug } }, body: target ? { commit: target } : {} })),
  );

  const saveGoal = (event: FormEvent) => {
    event.preventDefault();
    const tokens = parseTokenAmount(goal);
    setGoalInvalid(tokens === null);
    if (tokens === null) return;
    patch.mutate(
      { token_goal: tokens },
      {
        onSuccess: () => {
          setGoal('');
          toast.success('Goal saved');
        },
      },
    );
  };

  const submitRepin = (event: FormEvent) => {
    event.preventDefault();
    repin.mutate(commit.trim() || undefined, {
      onSuccess: () => {
        setCommit('');
        toast.success('Pin updated');
      },
    });
  };

  const commitInvalid = commit.trim() !== '' && !/^[0-9a-f]{40}$/.test(commit.trim());
  const canToggle = project.status === 'active' || project.status === 'paused';
  const active = project.status === 'active';
  const ToggleIcon = active ? Pause : Play;

  return (
    <article className="border px-6 pt-6 pb-1 sm:px-7" aria-labelledby={`manage-${slug}`}>
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3 pb-5">
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <h2 id={`manage-${slug}`} className="truncate text-[1.375rem] font-semibold tracking-[-0.03em]">
              {project.name}
            </h2>
            <span className={cn('flex h-5 items-center px-1.5 text-[0.6875rem] font-medium', active ? 'bg-pass-tint text-live' : 'border text-muted-foreground')}>
              {STATUS_LABELS[project.status]}
            </span>
          </div>
          <p className="num truncate text-xs text-muted-foreground">
            {project.repo_url.replace(/^https?:\/\//, '')} · key {project.pubkey_fingerprint.slice(0, 15)}… ·{' '}
            {project.tasks.open + project.tasks.claimed + project.tasks.delivered + project.tasks.merged} tasks
          </p>
        </div>
        <ButtonLink to={`/${slug}`} className="rounded-none">
          Open project ›
        </ButtonLink>
      </header>

      {(project.index_error || project.status === 'pending') && (
        <div className="grid gap-3 pb-5">
          {project.index_error && (
            <Notice tone="strong" title="The latest commit was not indexed" role="status">
              <p className="num text-[0.8125rem] text-foreground">{project.index_error}</p>
              <p>Fix the lock or its signature, push, then re-pin below. Donors keep working from the last good pin.</p>
            </Notice>
          )}
          {project.status === 'pending' && (
            <Notice>An instance admin has to approve this project before donors can see or claim it.</Notice>
          )}
        </div>
      )}

      <div className="grid gap-3 border-t py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="text-sm text-muted-foreground">
            <Num value={project.totals.delivered} className="text-lg font-medium tracking-tight text-live" /> delivered of{' '}
            <Num value={project.token_goal} className="text-foreground" />
            <span className="num ml-2 text-xs">{formatPercent(project.totals.delivered, project.token_goal)}</span>
          </p>
          <p className="num text-xs text-muted-foreground">
            <Num value={project.totals.pledged} className="text-foreground" /> pledged ·{' '}
            <span className="text-foreground">{project.tasks.claimable ?? 0}</span> claimable
          </p>
        </div>
        <FundingBar totals={project.totals} goal={project.token_goal} />
      </div>

      <Control title="Token goal" note="What the funding bar counts toward. Donors see it on the project page.">
        <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start" onSubmit={saveGoal} noValidate>
          <TextField
            label="Token goal"
            hideLabel
            mono
            placeholder={formatExact(project.token_goal)}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            hint="Accepts 60m, 1.5b or a full number."
            error={goalInvalid ? 'Enter a whole number of tokens, like 60m.' : null}
          />
          <Button type="submit" className="h-9 rounded-none" busy={patch.isPending} busyLabel="Saving…">
            Save goal
          </Button>
        </form>
      </Control>

      <Control title="Pinned commit" note="The commit workers claim tasks from. Re-pin after you push a newly signed lock.">
        <div className="grid gap-4">
          <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start" onSubmit={submitRepin} noValidate>
            <TextField
              label="Re-pin commit"
              hideLabel
              mono
              placeholder={`head of ${project.base_branch}`}
              value={commit}
              onChange={(event) => setCommit(event.target.value)}
              spellCheck={false}
              hint={
                <>
                  Pinned at <Hash value={project.pinned_commit} label="pinned commit" className="align-middle" />
                  {project.last_indexed_at && (
                    <>
                      , indexed <Time value={project.last_indexed_at} />
                    </>
                  )}
                  . Leave empty to pin the branch head.
                </>
              }
              error={commitInvalid ? 'A commit is 40 lowercase hex characters.' : null}
            />
            <Button type="submit" className="h-9 rounded-none" busy={repin.isPending} busyLabel="Indexing…" disabled={commitInvalid}>
              Re-pin
            </Button>
          </form>
          <SwitchField
            label={
              <>
                Follow <span className="num text-[0.8125rem]">{project.base_branch}</span>: advance the pin when a new head carries a
                valid signature
              </>
            }
            checked={project.follow_branch}
            disabled={patch.isPending}
            onCheckedChange={(checked) => patch.mutate({ follow_branch: checked })}
          />
        </div>
      </Control>

      {canToggle && (
        <Control title={active ? 'Pause' : 'Resume'} note={active ? 'Stops new claims. Running work finishes and still counts.' : 'Lets workers claim tasks again.'}>
          <Button busy={patch.isPending} busyLabel="Saving…" onClick={() => patch.mutate({ status: active ? 'paused' : 'active' })} className="rounded-none">
            <ToggleIcon strokeWidth={1.5} aria-hidden="true" />
            {active ? 'Pause project' : 'Resume project'}
          </Button>
        </Control>
      )}

      {(patch.isError || repin.isError) && (
        <div className="border-t py-5">
          <Notice tone="strong" role="alert" title="That change was not saved">
            {describeError(patch.error ?? repin.error)}
          </Notice>
        </div>
      )}

      {project.status !== 'removed' && (
        <div className="border-t">
          <WebhookPanel slug={slug} />
        </div>
      )}
    </article>
  );
}

/** Delivered tasks of one project: CI passed, the pull request waits for the maintainer. */
function ProjectReviews({ project }: { project: Project }) {
  const tasks = flatItems(useTasks(project.slug)).filter((task) => task.state === 'delivered');
  return (
    <>
      {tasks.map((task) => {
        const report = task.latest_report;
        const pr = report?.pr_url && /^https?:/.test(report.pr_url) ? report.pr_url : null;
        return (
          <li key={task.id} className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b py-4">
            <TokenDot state="delivered" />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <Link to={`/${project.slug}/tasks/${task.task_id}`} className="num truncate text-[0.8125rem] hover:underline">
                {task.task_id}
              </Link>
              {/* A donor from a peer makes this line long; on a phone it wraps rather than hiding the time. */}
              <span className="text-xs text-pretty text-muted-foreground sm:truncate">
                {project.name}
                {pr && ` · ${pullRequestLabel(pr)}`}
                {report?.donor && ` · by ${report.donor.handle}`}
                {report && (
                  <>
                    {' · CI passed '}
                    <Time value={report.created_at} />
                  </>
                )}
              </span>
            </div>
            <Num value={task.burn.total} className="w-20 text-right text-[0.8125rem] text-live" />
            {pr && (
              <a href={pr} rel="noreferrer" className="inline-flex h-8 items-center gap-1 bg-foreground px-3 text-[0.8125rem] font-medium text-background transition-opacity hover:opacity-90">
                Review on {new URL(pr).hostname.replace(/^www\./, '')} <ArrowUpRight className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </a>
            )}
          </li>
        );
      })}
    </>
  );
}

function Summary({ projects }: { projects: Project[] }) {
  const sum = (pick: (project: Project) => number) => projects.reduce((total, project) => total + pick(project), 0);
  const cells = [
    ['Projects', <span key="p">{projects.length}</span>, ''],
    ['Open tasks', <span key="o">{sum((project) => project.tasks.open)}</span>, `${sum((project) => project.tasks.claimable ?? 0)} claimable`],
    ['Awaiting your review', <span key="r">{sum((project) => project.tasks.delivered)}</span>, 'CI passed'],
    ['Delivered', <Num key="d" value={sum((project) => project.totals.delivered)} className="text-live" />, 'to your projects'],
  ] as const;
  return (
    <dl className="grid border-t border-b border-t-foreground sm:grid-cols-2 lg:grid-cols-4">
      {cells.map(([label, value, note], index) => (
        <div key={label} className={cn('grid content-start gap-2 border-b py-5 lg:border-b-0', index % 2 === 1 && 'sm:border-l sm:pl-6', index > 0 && 'lg:border-l lg:pl-6')}>
          <dt className="text-xs font-semibold tracking-[0.12em] uppercase">{label}</dt>
          <dd className="num text-4xl leading-none font-medium tracking-[-0.04em]">{value}</dd>
          {note && <dd className="text-[0.8125rem] text-muted-foreground">{note}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Dashboard({ handle }: { handle: string }) {
  const projects = useProjects({ maintainer: handle, limit: 50 });
  const items = flatItems(projects);

  if (projects.isPending) {
    return (
      <Loading label="your projects">
        <SkeletonRows rows={3} className="h-36 rounded-none" />
      </Loading>
    );
  }
  if (projects.isError) {
    return <ErrorState title="Couldn't load your projects" error={projects.error} onRetry={() => void projects.refetch()} />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="You maintain no projects here yet"
        icon={FolderGit2}
        action={
          <ButtonLink to="/maintain/new" variant="primary">
            Register a project
          </ButtonLink>
        }
      >
        <p>
          Any repository with an <code>agentfund.yaml</code> and a signed <code>tasks/MANIFEST.lock</code> can be
          registered. The wizard checks both before anything is created.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-14">
      <Summary projects={items} />
      <section aria-labelledby="reviews-title" className="group grid">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-b-foreground pb-3.5">
          <h2 id="reviews-title" className="text-2xl font-semibold tracking-[-0.03em]">
            Waiting on you
          </h2>
          <p className="text-[0.8125rem] text-muted-foreground">Delivered pull requests. Nothing merges without you.</p>
        </div>
        <ol aria-labelledby="reviews-title">
          {items.map((project) => (
            <ProjectReviews key={project.slug} project={project} />
          ))}
        </ol>
        <p className="py-5 text-sm text-muted-foreground group-has-[li]:hidden">Nothing to review. Delivered tasks appear here once CI passes.</p>
      </section>
      <section aria-labelledby="settings-title" className="grid gap-4">
        <h2 id="settings-title" className="text-2xl font-semibold tracking-[-0.03em]">
          Settings
        </h2>
        {items.map((project, index) => (
          <div key={project.slug} className="rise" style={{ '--i': index + 1 } as CSSProperties}>
            <ManageProject project={project} />
          </div>
        ))}
      </section>
    </div>
  );
}

export default function Maintain() {
  useDocumentTitle('Maintain');
  const token = useSession();
  const me = useMe();

  if (!token) {
    return <SignInRequired title="Maintain" reason="Sign in to register a repository or manage the projects you maintain." />;
  }

  return (
    <section className="container-page py-10 sm:py-12">
      <div>
        <header className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-3">
            <h1 className="text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.045em]">Your projects.</h1>
            <p className="max-w-2xl text-base text-pretty text-muted-foreground">
              Signed tasks, the work that came back, and the settings donors' workers rely on.
            </p>
          </div>
          <ButtonLink to="/maintain/new" variant="primary" size="lg" className="rounded-none px-5">
            Register a repository
          </ButtonLink>
        </header>
        {me.isPending ? (
          <Loading label="your account">
            <SkeletonRows rows={3} className="h-36 rounded-none" />
          </Loading>
        ) : me.isError ? (
          <ErrorState title="Couldn't load your account" error={me.error} onRetry={() => void me.refetch()} />
        ) : (
          <Dashboard handle={me.data.handle} />
        )}
      </div>
    </section>
  );
}
