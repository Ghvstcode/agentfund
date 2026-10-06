import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, Pause, Play, Plus } from 'lucide-react';
import { type CSSProperties, type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, unwrap } from '@/api/client';
import { flatItems, queryKeys, useMe, useProjects } from '@/api/queries';
import type { Project } from '@/api/types';
import { Button, ButtonLink } from '@/components/Button';
import { SwitchField, TextField } from '@/components/Field';
import { FundingBar } from '@/components/FundingBar';
import { Hash } from '@/components/Hash';
import { Num } from '@/components/Num';
import { SignInRequired } from '@/components/SignIn';
import { describeError, EmptyState, ErrorState, Loading, Notice, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { Badge } from '@/components/ui/badge';
import { WebhookPanel } from '@/components/WebhookPanel';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useSession } from '@/hooks/useSession';
import { formatExact, formatPercent, parseTokenAmount } from '@/lib/format';

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

/** One control group in a project card: what it changes, then the control. */
function Control({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-3 p-5">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {children}
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
    <article className="surface overflow-hidden" aria-labelledby={`manage-${slug}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-4">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 id={`manage-${slug}`} className="truncate text-base font-semibold tracking-tight">
              <Link to={`/${slug}`} className="underline-offset-4 hover:underline">
                {project.name}
              </Link>
            </h2>
            <Badge variant={active ? 'outline' : 'secondary'}>{STATUS_LABELS[project.status]}</Badge>
          </div>
          <p className="num truncate text-xs text-muted-foreground">{project.repo_url.replace(/^https?:\/\//, '')}</p>
        </div>
        {canToggle && (
          <Button size="sm" busy={patch.isPending} busyLabel="Saving…" onClick={() => patch.mutate({ status: active ? 'paused' : 'active' })}>
            <ToggleIcon strokeWidth={1.5} aria-hidden="true" />
            {active ? 'Pause' : 'Resume'}
          </Button>
        )}
      </header>

      {(project.index_error || project.status === 'pending') && (
        <div className="grid gap-3 border-b p-5">
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

      <div className="grid gap-3 border-b p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="text-sm text-muted-foreground">
            <Num value={project.totals.delivered} className="text-lg font-medium tracking-tight text-foreground" /> delivered of{' '}
            <Num value={project.token_goal} className="text-foreground" />
            <span className="num ml-2 text-xs">{formatPercent(project.totals.delivered, project.token_goal)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            <Num value={project.totals.pledged} className="text-foreground" /> pledged ·{' '}
            <span className="num text-foreground">{project.tasks.claimable ?? 0}</span> claimable tasks
          </p>
        </div>
        <FundingBar totals={project.totals} goal={project.token_goal} />
      </div>

      <div className="grid divide-y border-b md:grid-cols-2 md:divide-x md:divide-y-0">
        <Control title="Token goal">
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
            <Button type="submit" className="h-9" busy={patch.isPending} busyLabel="Saving…">
              Save goal
            </Button>
          </form>
        </Control>

        <Control title="Pinned commit">
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
            <Button type="submit" className="h-9" busy={repin.isPending} busyLabel="Indexing…" disabled={commitInvalid}>
              Re-pin
            </Button>
          </form>
        </Control>
      </div>

      <div className="border-b px-5 py-3 last:border-b-0">
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

      {(patch.isError || repin.isError) && (
        <div className="border-b p-5 last:border-b-0">
          <Notice tone="strong" role="alert" title="That change was not saved">
            {describeError(patch.error ?? repin.error)}
          </Notice>
        </div>
      )}

      {project.status !== 'removed' && <WebhookPanel slug={slug} />}
    </article>
  );
}

function Dashboard({ handle }: { handle: string }) {
  const projects = useProjects({ maintainer: handle, limit: 50 });
  const items = flatItems(projects);

  if (projects.isPending) {
    return (
      <Loading label="your projects">
        <SkeletonRows rows={3} className="h-36 rounded-xl" />
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
    <div className="grid gap-6">
      {items.map((project, index) => (
        <div key={project.slug} className="rise" style={{ '--i': index + 1 } as CSSProperties}>
          <ManageProject project={project} />
        </div>
      ))}
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
    <section className="container-page py-10">
      <div className="mx-auto max-w-4xl">
        <header className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Maintain</h1>
            <p className="max-w-prose text-sm text-muted-foreground">Projects you maintain on this instance.</p>
          </div>
          <ButtonLink to="/maintain/new" variant="primary">
            <Plus strokeWidth={1.5} aria-hidden="true" />
            Register a project
          </ButtonLink>
        </header>
        {me.isPending ? (
          <Loading label="your account">
            <SkeletonRows rows={3} className="h-36 rounded-xl" />
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
