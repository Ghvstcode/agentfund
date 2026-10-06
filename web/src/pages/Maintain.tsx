import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { api, unwrap } from '../api/client';
import { flatItems, queryKeys, useMe, useProjects } from '../api/queries';
import type { Project } from '../api/types';
import { Badge } from '../components/Badge';
import { Button, ButtonLink } from '../components/Button';
import { Checkbox, TextField } from '../components/Field';
import { FundingBar } from '../components/FundingBar';
import { Hash } from '../components/Hash';
import { Num } from '../components/Num';
import { SignInRequired } from '../components/SignIn';
import { describeError, EmptyState, ErrorState, Loading, Notice, SkeletonRows } from '../components/States';
import { Time } from '../components/Time';
import { WebhookPanel } from '../components/WebhookPanel';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSession } from '../hooks/useSession';
import { formatExact, parseTokenAmount } from '../lib/format';

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
    patch.mutate({ token_goal: tokens }, { onSuccess: () => setGoal('') });
  };

  const submitRepin = (event: FormEvent) => {
    event.preventDefault();
    repin.mutate(commit.trim() || undefined, { onSuccess: () => setCommit('') });
  };

  const commitInvalid = commit.trim() !== '' && !/^[0-9a-f]{40}$/.test(commit.trim());
  const canToggle = project.status === 'active' || project.status === 'paused';

  return (
    <article className="manage" aria-labelledby={`manage-${slug}`}>
      <header className="manage__header">
        <h2 id={`manage-${slug}`}>
          <Link to={`/${slug}`}>{project.name}</Link>
        </h2>
        <Badge tone={project.status === 'active' ? 'plain' : 'strong'}>{STATUS_LABELS[project.status]}</Badge>
        {canToggle && (
          <Button
            size="sm"
            busy={patch.isPending}
            busyLabel="Saving…"
            onClick={() => patch.mutate({ status: project.status === 'active' ? 'paused' : 'active' })}
          >
            {project.status === 'active' ? 'Pause' : 'Resume'}
          </Button>
        )}
      </header>

      {project.index_error && (
        <Notice tone="strong" title="The latest commit was not indexed" role="status">
          <p>{project.index_error}</p>
          <p className="muted">Fix the lock or its signature, push, then re-pin below. Donors keep working from the last good pin.</p>
        </Notice>
      )}
      {project.status === 'pending' && (
        <Notice>An instance admin has to approve this project before donors can see or claim it.</Notice>
      )}

      <div className="manage__funding">
        <p>
          <Num value={project.totals.delivered} /> delivered of <Num value={project.token_goal} /> ·{' '}
          <Num value={project.totals.pledged} /> pledged · <span className="mono">{project.tasks.claimable ?? 0}</span>{' '}
          claimable tasks
        </p>
        <FundingBar totals={project.totals} goal={project.token_goal} />
      </div>

      <div className="manage__controls">
        <form className="inline-form" onSubmit={saveGoal} noValidate>
          <TextField
            label="Token goal"
            mono
            placeholder={formatExact(project.token_goal)}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            hint="Accepts 60m, 1.5b or a full number."
            error={goalInvalid ? 'Enter a whole number of tokens, like 60m.' : null}
          />
          <Button type="submit" busy={patch.isPending} busyLabel="Saving…">
            Save goal
          </Button>
        </form>

        <form className="inline-form" onSubmit={submitRepin} noValidate>
          <TextField
            label="Re-pin commit"
            mono
            placeholder={`head of ${project.base_branch}`}
            value={commit}
            onChange={(event) => setCommit(event.target.value)}
            spellCheck={false}
            hint={
              <>
                Pinned at <Hash value={project.pinned_commit} label="pinned commit" />
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
          <Button type="submit" busy={repin.isPending} busyLabel="Indexing…" disabled={commitInvalid}>
            Re-pin
          </Button>
        </form>

        <Checkbox
          label={
            <>
              Follow <span className="mono">{project.base_branch}</span>: advance the pin when a new head carries a valid
              signature
            </>
          }
          checked={project.follow_branch}
          disabled={patch.isPending}
          onChange={(event) => patch.mutate({ follow_branch: event.target.checked })}
        />
      </div>

      {project.status !== 'removed' && <WebhookPanel slug={slug} />}

      {(patch.isError || repin.isError) && (
        <Notice tone="strong" role="alert" title="That change was not saved">
          {describeError(patch.error ?? repin.error)}
        </Notice>
      )}
    </article>
  );
}

function Dashboard({ handle }: { handle: string }) {
  const projects = useProjects({ maintainer: handle, limit: 50 });
  const items = flatItems(projects);

  if (projects.isPending) {
    return (
      <Loading label="your projects">
        <SkeletonRows rows={3} height="9rem" />
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
    <div className="manage-list">
      {items.map((project) => (
        <ManageProject key={project.slug} project={project} />
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
    <section className="page">
      <header className="page__header page__header--split">
        <div>
          <h1>Maintain</h1>
          <p className="lede">Projects you maintain on this instance.</p>
        </div>
        <ButtonLink to="/maintain/new" variant="primary">
          Register a project
        </ButtonLink>
      </header>
      {me.isPending ? (
        <Loading label="your account">
          <SkeletonRows rows={3} height="9rem" />
        </Loading>
      ) : me.isError ? (
        <ErrorState title="Couldn't load your account" error={me.error} onRetry={() => void me.refetch()} />
      ) : (
        <Dashboard handle={me.data.handle} />
      )}
    </section>
  );
}
