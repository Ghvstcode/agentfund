import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, FolderGit2, Loader2, MoreHorizontal, Pause, Play, RotateCcw, ShieldAlert, Trash2, Users as UsersIcon } from 'lucide-react';
import { type CSSProperties, type FormEvent, type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { api, unwrap } from '@/api/client';
import { flatItems, queryKeys, useAdminProjects, useAdminUsers, useInstanceConfig, useMe } from '@/api/queries';
import type { InstanceConfig, InstanceConfigUpdate, Me, Project, ProjectStatus, Role } from '@/api/types';
import { Button } from '@/components/Button';
import { SelectField, TextField } from '@/components/Field';
import { Num } from '@/components/Num';
import { SignInRequired } from '@/components/SignIn';
import { describeError, EmptyState, ErrorState, Loading, LoadMore, Notice, SkeletonRows } from '@/components/States';
import { Tabs } from '@/components/Tabs';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UserLink } from '@/components/UserLink';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useSession } from '@/hooks/useSession';
import { formatDate } from '@/lib/format';

const ROLES: Role[] = ['donor', 'maintainer', 'admin'];
const COLUMN = 'h-9 text-xs font-medium text-muted-foreground';

interface ConfirmDialogProps {
  title: string;
  /** What happens if the admin goes ahead. */
  consequence: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** The second step of a destructive action: says what will happen before it does. */
function ConfirmDialog({ title, consequence, confirmLabel, onConfirm, onClose }: ConfirmDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="shadow-raised">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">{title}</DialogTitle>
          <DialogDescription className="text-pretty">{consequence}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowError({ error }: { error: unknown }) {
  return (
    <span className="mt-1 block text-xs font-medium whitespace-normal text-destructive" role="alert">
      {describeError(error)}
    </span>
  );
}

function UserRow({ user, self }: { user: Me; self: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const update = useMutation({
    mutationFn: (body: { role?: Role; banned?: boolean }) =>
      unwrap(api.PATCH('/v1/admin/users/{handle}', { params: { path: { handle: user.handle } }, body })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
  return (
    <TableRow className="hover:bg-muted/40">
      <TableHead scope="row" className="pl-5 font-normal">
        <span className="flex items-center gap-2">
          <UserLink handle={user.handle} avatar />
          {user.banned && <Badge variant="secondary">Banned</Badge>}
        </span>
      </TableHead>
      <TableCell>
        <SelectField
          label={`Role of ${user.handle}`}
          hideLabel
          className="h-8 w-32"
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
      </TableCell>
      <TableCell className="hidden md:table-cell">{user.github_login ?? <span className="text-muted-foreground">dev login</span>}</TableCell>
      <TableCell className="hidden md:table-cell text-muted-foreground tabular-nums">{formatDate(user.created_at)}</TableCell>
      <TableCell className="pr-5 text-right">
        {self ? (
          <span className="text-xs text-muted-foreground">You</span>
        ) : user.banned ? (
          <Button size="sm" busy={update.isPending} busyLabel="Working…" onClick={() => update.mutate({ banned: false })} aria-label={`Unban ${user.handle}`}>
            Unban
          </Button>
        ) : (
          <Button size="sm" busy={update.isPending} busyLabel="Working…" onClick={() => setConfirming(true)} aria-label={`Ban ${user.handle}`}>
            Ban
          </Button>
        )}
        {update.isError && <RowError error={update.error} />}
        {confirming && (
          <ConfirmDialog
            title={`Ban ${user.handle}?`}
            consequence="Their sessions end and their API keys stop working straight away. They cannot sign in again until you unban them."
            confirmLabel="Ban user"
            onConfirm={() => update.mutate({ banned: true })}
            onClose={() => setConfirming(false)}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

function Users({ me }: { me: Me }) {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const query = useAdminUsers(q);
  const users = flatItems(query);
  return (
    <section className="grid gap-4" aria-labelledby="admin-users">
      <h2 id="admin-users" className="sr-only">
        Users
      </h2>
      <form className="max-w-xs" role="search" aria-label="Filter users" onSubmit={(event) => event.preventDefault()}>
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
        <EmptyState title={q ? `No user matches “${q}”` : 'No users yet'} icon={UsersIcon} />
      ) : (
        <>
          <div className="surface overflow-hidden">
            <Table aria-label="Users">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className={`${COLUMN} pl-5`}>
                    Handle
                  </TableHead>
                  <TableHead scope="col" className={COLUMN}>
                    Role
                  </TableHead>
                  <TableHead scope="col" className={`${COLUMN} hidden md:table-cell`}>
                    GitHub
                  </TableHead>
                  <TableHead scope="col" className={`${COLUMN} hidden md:table-cell`}>
                    Joined
                  </TableHead>
                  <TableHead scope="col" className={`${COLUMN} pr-5`}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <UserRow key={user.handle} user={user} self={user.handle === me.handle} />
                ))}
              </TableBody>
            </Table>
          </div>
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
  const [confirming, setConfirming] = useState(false);
  const moderate = useMutation({
    mutationFn: (status: ProjectStatus) =>
      unwrap(api.PATCH('/v1/admin/projects/{slug}', { params: { path: { slug: project.slug } }, body: { status } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminProjects });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const { status } = project;
  return (
    <TableRow className="hover:bg-muted/40">
      <TableHead scope="row" className="h-auto w-full max-w-0 py-2.5 pl-5 font-normal">
        <Link to={`/${project.slug}`} className="block truncate font-medium underline-offset-4 hover:underline">
          {project.name}
        </Link>
        <span className="num block truncate text-xs text-muted-foreground">{project.repo_url.replace(/^https?:\/\//, '')}</span>
      </TableHead>
      <TableCell>
        <Badge variant={status === 'active' ? 'outline' : 'secondary'}>{STATUS_LABELS[status]}</Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <UserLink handle={project.maintainer.handle} avatar />
      </TableCell>
      <TableCell className="hidden md:table-cell text-right">
        <Num value={project.totals.delivered} />
      </TableCell>
      <TableCell className="pr-5 text-right">
        <span className="inline-flex items-center gap-1.5">
          {/* Approval is what a pending row is waiting for, so it does not hide in the menu. */}
          {status === 'pending' && (
            <Button size="sm" busy={moderate.isPending} busyLabel="Working…" onClick={() => moderate.mutate('active')} aria-label={`Approve ${project.name}`}>
              <Check strokeWidth={1.5} aria-hidden="true" />
              Approve
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${project.name}`}
                disabled={moderate.isPending}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 aria-expanded:bg-muted aria-expanded:text-foreground"
              >
                {moderate.isPending ? (
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <MoreHorizontal className="size-4" strokeWidth={1.5} aria-hidden="true" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {status === 'pending' && (
                <DropdownMenuItem onSelect={() => moderate.mutate('active')}>
                  <Check strokeWidth={1.5} aria-hidden="true" /> Approve
                </DropdownMenuItem>
              )}
              {status === 'active' && (
                <DropdownMenuItem onSelect={() => moderate.mutate('paused')}>
                  <Pause strokeWidth={1.5} aria-hidden="true" /> Pause
                </DropdownMenuItem>
              )}
              {status === 'paused' && (
                <DropdownMenuItem onSelect={() => moderate.mutate('active')}>
                  <Play strokeWidth={1.5} aria-hidden="true" /> Resume
                </DropdownMenuItem>
              )}
              {status === 'removed' ? (
                <DropdownMenuItem onSelect={() => moderate.mutate('paused')}>
                  <RotateCcw strokeWidth={1.5} aria-hidden="true" /> Restore
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                    <Trash2 strokeWidth={1.5} aria-hidden="true" /> Remove…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
        {moderate.isError && <RowError error={moderate.error} />}
        {confirming && (
          <ConfirmDialog
            title={`Remove ${project.name}?`}
            consequence="The project is taken off this instance: it is no longer listed and its tasks cannot be claimed. Its history is kept, and you can restore it from this list."
            confirmLabel="Remove project"
            onConfirm={() => moderate.mutate('removed')}
            onClose={() => setConfirming(false)}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

function Projects() {
  const query = useAdminProjects();
  const projects = flatItems(query);
  return (
    <section className="grid gap-4" aria-labelledby="admin-projects">
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
        <EmptyState title="No projects on this instance" icon={FolderGit2}>
          <p>Projects in every status, including pending and removed ones, are listed here.</p>
        </EmptyState>
      ) : (
        <>
          <div className="surface overflow-hidden">
            <Table aria-label="All projects">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className={`${COLUMN} pl-5`}>
                    Project
                  </TableHead>
                  <TableHead scope="col" className={COLUMN}>
                    Status
                  </TableHead>
                  <TableHead scope="col" className={`${COLUMN} hidden md:table-cell`}>
                    Maintainer
                  </TableHead>
                  <TableHead scope="col" className={`${COLUMN} text-right hidden md:table-cell`}>
                    Delivered
                  </TableHead>
                  <TableHead scope="col" className={`${COLUMN} pr-5`}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <ProjectRow key={project.slug} project={project} />
                ))}
              </TableBody>
            </Table>
          </div>
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

/** One group of instance settings: what it governs on the left, the controls on the right. */
function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <fieldset className="grid min-w-0 gap-x-8 gap-y-4 border-b p-5 md:grid-cols-[14rem_minmax(0,1fr)]">
      <legend className="sr-only">{title}</legend>
      <div className="grid content-start gap-1" aria-hidden="true">
        <p className="text-sm font-semibold tracking-tight">{title}</p>
        <p className="text-xs text-pretty text-muted-foreground">{description}</p>
      </div>
      <div className="grid min-w-0 gap-5">{children}</div>
    </fieldset>
  );
}

function InstanceForm({ config }: { config: InstanceConfig }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<InstanceConfig>(config);
  const save = useMutation({
    mutationFn: (body: InstanceConfigUpdate) => unwrap(api.PATCH('/v1/admin/instance', { body })),
    onSuccess: (saved) => {
      setDraft(saved);
      queryClient.setQueryData(queryKeys.instance, saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.meta });
      toast.success('Configuration saved');
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
    <form className="surface overflow-hidden" onSubmit={submit}>
      <Group title="Identity" description="How this instance names itself in the header, link previews and search results.">
        <TextField label="Instance name" value={draft.name} onChange={(event) => set('name', event.target.value)} required maxLength={80} />
        <TextField
          label="Description"
          value={draft.description}
          onChange={(event) => set('description', event.target.value)}
          maxLength={500}
          hint="One sentence, used in link previews and search results."
        />
      </Group>
      <Group title="Registration" description="Who can put a new project in front of donors.">
        <SelectField
          label="Project creation"
          value={draft.project_creation}
          onChange={(event) => set('project_creation', event.target.value === 'approval' ? 'approval' : 'open')}
          hint="With approval, new projects stay pending until an admin activates them."
        >
          <option value="open">Open: anyone signed in can register a project</option>
          <option value="approval">Approval: an admin reviews each new project</option>
        </SelectField>
      </Group>
      <Group title="Limits" description="Leases, and the caps that hold a new project back until it has merged work to show.">
        <div className="grid gap-5 sm:grid-cols-2">
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
        </div>
      </Group>
      {save.isError && (
        <div className="border-b p-5">
          <Notice tone="strong" role="alert" title="The configuration was not saved">
            {describeError(save.error)}
          </Notice>
        </div>
      )}
      <div className="flex items-center justify-end gap-3 bg-muted/40 px-5 py-3">
        {save.isSuccess && (
          <span role="status" className="text-xs text-muted-foreground">
            Saved.
          </span>
        )}
        <Button type="submit" variant="primary" busy={save.isPending} busyLabel="Saving…">
          Save configuration
        </Button>
      </div>
    </form>
  );
}

function Instance() {
  const config = useInstanceConfig();
  return (
    <section className="max-w-4xl" aria-labelledby="admin-instance">
      <h2 id="admin-instance" className="sr-only">
        Instance
      </h2>
      {config.isPending ? (
        <Loading label="instance configuration">
          <SkeletonRows rows={6} className="h-14" />
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
    <div className="container-page py-10">
      <header className="rise mb-8 grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="max-w-prose text-sm text-muted-foreground">Users, projects and configuration of this instance.</p>
      </header>
      <div className="rise grid gap-6" style={{ '--i': 1 } as CSSProperties}>
        {me.isPending ? (
          <Loading label="your account">
            <SkeletonRows rows={5} />
          </Loading>
        ) : me.isError ? (
          <ErrorState title="Couldn't load your account" error={me.error} onRetry={() => void me.refetch()} />
        ) : me.data.role !== 'admin' ? (
          <EmptyState title="Admins only" icon={ShieldAlert}>
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
    </div>
  );
}
