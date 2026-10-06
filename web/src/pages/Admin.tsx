import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, unwrap } from '../api/client';
import { flatItems, queryKeys, useAdminProjects, useAdminUsers, useInstanceConfig, useMe } from '../api/queries';
import type { InstanceConfig, InstanceConfigUpdate, Me, Project, ProjectStatus, Role } from '../api/types';
import { Button } from '../components/Button';
import { ConfirmButton } from '../components/ConfirmButton';
import { SelectField, TextField } from '../components/Field';
import { Num } from '../components/Num';
import { SignInRequired } from '../components/SignIn';
import { describeError, EmptyState, ErrorState, Loading, LoadMore, Notice, SkeletonRows } from '../components/States';
import { TableScroll } from '../components/TableScroll';
import { Tabs } from '../components/Tabs';
import { UserLink } from '../components/UserLink';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSession } from '../hooks/useSession';
import { formatDate } from '../lib/format';

const ROLES: Role[] = ['donor', 'maintainer', 'admin'];

function UserRow({ user, self }: { user: Me; self: boolean }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (body: { role?: Role; banned?: boolean }) =>
      unwrap(api.PATCH('/v1/admin/users/{handle}', { params: { path: { handle: user.handle } }, body })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
  return (
    <tr>
      <th scope="row">
        <UserLink handle={user.handle} />
        {user.banned && <span className="table__sub">Banned</span>}
      </th>
      <td>
        <SelectField
          label={`Role of ${user.handle}`}
          hideLabel
          value={user.role}
          disabled={self || update.isPending}
          onChange={(event) => update.mutate({ role: event.target.value as Role })}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </SelectField>
      </td>
      <td>{user.github_login ?? <span className="muted">dev login</span>}</td>
      <td>{formatDate(user.created_at)}</td>
      <td className="table__actions">
        {self ? (
          <span className="muted">You</span>
        ) : user.banned ? (
          <Button size="sm" busy={update.isPending} busyLabel="Working…" onClick={() => update.mutate({ banned: false })}>
            Unban
          </Button>
        ) : (
          <ConfirmButton
            label="Ban"
            confirmLabel="Ban user"
            subject={user.handle}
            busy={update.isPending}
            onConfirm={() => update.mutate({ banned: true })}
          />
        )}
        {update.isError && (
          <span className="table__sub" role="alert">
            {describeError(update.error)}
          </span>
        )}
      </td>
    </tr>
  );
}

function Users({ me }: { me: Me }) {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const query = useAdminUsers(q);
  const users = flatItems(query);
  return (
    <section className="tab-panel" aria-labelledby="admin-users">
      <h2 id="admin-users" className="sr-only">
        Users
      </h2>
      <form className="filters" role="search" aria-label="Filter users" onSubmit={(event) => event.preventDefault()}>
        <TextField
          label="Search users"
          hideLabel
          type="search"
          placeholder="Search by handle"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </form>
      {query.isPending ? (
        <Loading label="users">
          <SkeletonRows rows={6} />
        </Loading>
      ) : query.isError ? (
        <ErrorState title="Couldn't load users" error={query.error} onRetry={() => void query.refetch()} />
      ) : users.length === 0 ? (
        <EmptyState title={q ? `No user matches “${q}”` : 'No users yet'} />
      ) : (
        <>
          <TableScroll label="Users">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Handle</th>
                  <th scope="col">Role</th>
                  <th scope="col">GitHub</th>
                  <th scope="col">Joined</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <UserRow key={user.handle} user={user} self={user.handle === me.handle} />
                ))}
              </tbody>
            </table>
          </TableScroll>
          <LoadMore hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoad={() => void query.fetchNextPage()} />
        </>
      )}
    </section>
  );
}

const STATUS_LABELS: Record<ProjectStatus, string> = {
  pending: 'Pending approval',
  active: 'Active',
  paused: 'Paused',
  removed: 'Removed',
};

function ProjectRow({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const moderate = useMutation({
    mutationFn: (status: ProjectStatus) =>
      unwrap(api.PATCH('/v1/admin/projects/{slug}', { params: { path: { slug: project.slug } }, body: { status } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminProjects });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const action = (label: string, status: ProjectStatus) => (
    <Button size="sm" busy={moderate.isPending} busyLabel="Working…" onClick={() => moderate.mutate(status)} aria-label={`${label} ${project.name}`}>
      {label}
    </Button>
  );
  return (
    <tr>
      <th scope="row">
        <Link to={`/${project.slug}`}>{project.name}</Link>
        <span className="table__sub mono">{project.repo_url.replace(/^https?:\/\//, '')}</span>
      </th>
      <td>
        {project.status === 'pending' || project.status === 'removed' ? (
          <strong>{STATUS_LABELS[project.status]}</strong>
        ) : (
          STATUS_LABELS[project.status]
        )}
      </td>
      <td>
        <UserLink handle={project.maintainer.handle} />
      </td>
      <td className="table__num">
        <Num value={project.totals.delivered} />
      </td>
      <td className="table__actions">
        <span className="button-row button-row--tight">
          {project.status === 'pending' && action('Approve', 'active')}
          {project.status === 'active' && action('Pause', 'paused')}
          {project.status === 'paused' && action('Resume', 'active')}
          {project.status === 'removed' ? (
            action('Restore', 'paused')
          ) : (
            <ConfirmButton
              label="Remove"
              confirmLabel="Remove project"
              subject={project.name}
              busy={moderate.isPending}
              onConfirm={() => moderate.mutate('removed')}
            />
          )}
        </span>
        {moderate.isError && (
          <span className="table__sub" role="alert">
            {describeError(moderate.error)}
          </span>
        )}
      </td>
    </tr>
  );
}

function Projects() {
  const query = useAdminProjects();
  const projects = flatItems(query);
  return (
    <section className="tab-panel" aria-labelledby="admin-projects">
      <h2 id="admin-projects" className="sr-only">
        Projects
      </h2>
      {query.isPending ? (
        <Loading label="projects">
          <SkeletonRows rows={6} />
        </Loading>
      ) : query.isError ? (
        <ErrorState title="Couldn't load projects" error={query.error} onRetry={() => void query.refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState title="No projects on this instance">
          <p>Projects in every status, including pending and removed ones, are listed here.</p>
        </EmptyState>
      ) : (
        <>
          <TableScroll label="All projects">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Status</th>
                  <th scope="col">Maintainer</th>
                  <th scope="col" className="table__num">
                    Delivered
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <ProjectRow key={project.slug} project={project} />
                ))}
              </tbody>
            </table>
          </TableScroll>
          <LoadMore hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoad={() => void query.fetchNextPage()} />
        </>
      )}
    </section>
  );
}

const NUMBER_FIELDS = [
  ['lease_seconds', 'Lease length (seconds)', 'How long a claim lasts without a heartbeat. Minimum 60.'],
  ['max_active_claims_per_donor', 'Active claims per donor', 'How many tasks one donor may hold at once.'],
  ['new_project_max_tokens_per_task', 'New project: tokens per task', 'Claims on larger manifests are refused while a project is new.'],
  ['new_project_max_tokens_per_day', 'New project: tokens per day', 'Sum of task caps a new project may hand out per UTC day.'],
  ['established_after_merged_tasks', 'Merged tasks to become established', 'After this many merged tasks the new-project caps lift.'],
] as const satisfies readonly (readonly [keyof InstanceConfig, string, string])[];

function InstanceForm({ config }: { config: InstanceConfig }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<InstanceConfig>(config);
  const save = useMutation({
    mutationFn: (body: InstanceConfigUpdate) => unwrap(api.PATCH('/v1/admin/instance', { body })),
    onSuccess: (saved) => {
      setDraft(saved);
      queryClient.setQueryData(queryKeys.instance, saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.meta });
    },
  });
  const set = <K extends keyof InstanceConfig>(key: K, value: InstanceConfig[K]) => {
    save.reset();
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(draft);
  };

  return (
    <form className="form-stack" onSubmit={submit}>
      <TextField label="Instance name" value={draft.name} onChange={(event) => set('name', event.target.value)} required maxLength={80} />
      <TextField
        label="Description"
        value={draft.description}
        onChange={(event) => set('description', event.target.value)}
        maxLength={500}
        hint="One sentence, shown on the home page and in link previews."
      />
      <SelectField
        label="Project creation"
        value={draft.project_creation}
        onChange={(event) => set('project_creation', event.target.value === 'approval' ? 'approval' : 'open')}
        hint="With approval, new projects stay pending until an admin activates them."
      >
        <option value="open">Open: anyone signed in can register a project</option>
        <option value="approval">Approval: an admin reviews each new project</option>
      </SelectField>
      {NUMBER_FIELDS.map(([key, label, hint]) => (
        <TextField
          key={key}
          label={label}
          hint={hint}
          mono
          type="number"
          min={key === 'lease_seconds' ? 60 : key === 'established_after_merged_tasks' ? 0 : 1}
          step={1}
          required
          value={draft[key]}
          onChange={(event) => set(key, event.target.valueAsNumber)}
        />
      ))}
      {save.isError && (
        <Notice tone="strong" role="alert" title="The configuration was not saved">
          {describeError(save.error)}
        </Notice>
      )}
      <div className="button-row">
        <Button type="submit" variant="primary" busy={save.isPending} busyLabel="Saving…">
          Save configuration
        </Button>
        {save.isSuccess && (
          <span role="status" className="muted">
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}

function Instance() {
  const config = useInstanceConfig();
  return (
    <section className="tab-panel tab-panel--narrow" aria-labelledby="admin-instance">
      <h2 id="admin-instance" className="sr-only">
        Instance
      </h2>
      {config.isPending ? (
        <Loading label="instance configuration">
          <SkeletonRows rows={6} height="3.5rem" />
        </Loading>
      ) : config.isError ? (
        <ErrorState title="Couldn't load the configuration" error={config.error} onRetry={() => void config.refetch()} />
      ) : (
        <InstanceForm config={config.data} />
      )}
    </section>
  );
}

export default function Admin() {
  useDocumentTitle('Admin');
  const { section } = useParams();
  const token = useSession();
  const me = useMe();

  if (!token) return <SignInRequired title="Admin" reason="Sign in with an admin account to manage this instance." />;

  return (
    <div className="page">
      <header className="page__header">
        <h1>Admin</h1>
        <p className="lede">Users, projects and configuration of this instance.</p>
      </header>
      {me.isPending ? (
        <Loading label="your account">
          <SkeletonRows rows={5} />
        </Loading>
      ) : me.isError ? (
        <ErrorState title="Couldn't load your account" error={me.error} onRetry={() => void me.refetch()} />
      ) : me.data.role !== 'admin' ? (
        <EmptyState title="Admins only">
          <p>
            You are signed in as <strong>{me.data.handle}</strong>, which is not an admin account on this instance.
          </p>
        </EmptyState>
      ) : (
        <>
          <Tabs
            label="Admin sections"
            items={[
              { to: '/admin', label: 'Users', end: true },
              { to: '/admin/projects', label: 'Projects' },
              { to: '/admin/instance', label: 'Instance' },
            ]}
          />
          {section === 'projects' ? <Projects /> : section === 'instance' ? <Instance /> : <Users me={me.data} />}
        </>
      )}
    </div>
  );
}
