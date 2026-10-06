import { FileLock2, Fingerprint, GitCommitHorizontal, History, KeyRound, type LucideIcon, ShieldCheck, TriangleAlert, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import { flatItems, useMeta, useProjectEvents } from '@/api/queries';
import type { AuditEvent } from '@/api/types';
import { CommandLine } from '@/components/CommandLine';
import { CopyButton } from '@/components/CopyButton';
import { eventIcon } from '@/components/EventLine';
import { EmptyState, ErrorState, Loading, LoadMore, Notice, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { UserLink } from '@/components/UserLink';
import { CLI_NAME } from '@/config';
import { isDeliveryEvent, manifestId } from '@/lib/events';
import { absoluteTime, formatExact, groupHex } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useProjectContext } from './ProjectPage';

interface ArtifactProps {
  icon: LucideIcon;
  title: string;
  /** The value being vouched for, already formatted. */
  value: ReactNode;
  /** Raw value for the clipboard. */
  copy: string;
  copyLabel: string;
  children: ReactNode;
  /** Shell lines that let anyone reproduce the value without trusting this page. */
  verify?: { label: string; command: string }[];
  link?: { href: string; label: string };
}

/** One thing the instance vouches for, with the command that checks it independently. */
function Artifact({ icon: Icon, title, value, copy, copyLabel, children, verify, link }: ArtifactProps) {
  return (
    <article className="surface grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5">
      <header className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-md border bg-muted/50">
          <Icon className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        </span>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {link && /^https?:/.test(link.href) && (
          <a href={link.href} rel="noreferrer" className="link ml-auto text-xs text-muted-foreground">
            {link.label}
          </a>
        )}
      </header>
      <div className="flex items-start gap-2 rounded-lg border bg-muted/40 py-2 pr-2 pl-3">
        <div className="num min-w-0 flex-1 py-0.5 text-[0.8125rem] leading-6 [overflow-wrap:anywhere]">{value}</div>
        <CopyButton text={copy} label={copyLabel} />
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 text-sm text-pretty text-muted-foreground [&_code]:text-foreground [&_code]:[overflow-wrap:anywhere]">{children}</div>
      {verify && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 pt-1">
          <p className="label">Verify it yourself</p>
          {verify.map((line) => (
            <CommandLine key={line.command} command={line.command} label={line.label} />
          ))}
        </div>
      )}
    </article>
  );
}

/** Hex in groups of four, so two people can compare it aloud. */
function Grouped({ prefix, hex }: { prefix?: string; hex: string }) {
  return (
    <span className="flex flex-wrap gap-x-2">
      {prefix && <span className="text-muted-foreground">{prefix}</span>}
      {groupHex(hex).map((group, index) => (
        <span key={index}>{group}</span>
      ))}
    </span>
  );
}

function TimelineRow({ event, fresh }: { event: AuditEvent; fresh: boolean }) {
  const Icon = eventIcon(event);
  const payload = event.payload && Object.keys(event.payload).length > 0 ? event.payload : null;
  return (
    <li className={cn('relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 pb-5 last:pb-0', fresh && 'animate-enter')}>
      {/* The rail that joins one event to the next. */}
      <span aria-hidden="true" className="absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 bg-border [li:last-child>&]:hidden" />
      <span
        className={cn(
          'relative flex size-6 items-center justify-center rounded-full border bg-card',
          isDeliveryEvent(event) ? 'border-live/30 text-live' : 'text-muted-foreground',
        )}
      >
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <div className="grid min-w-0 gap-1 pt-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <code className="rounded-md border bg-muted/50 px-1.5 py-px text-xs">{event.action}</code>
          {event.task_id && <span className="num text-xs text-muted-foreground">{manifestId(event.task_id)}</span>}
          <span className="text-muted-foreground">by</span>
          {event.actor ? <UserLink handle={event.actor} /> : <span className="text-muted-foreground">unknown</span>}
          <time dateTime={event.at} title={absoluteTime(event.at)} className="num ml-auto text-xs whitespace-nowrap text-muted-foreground">
            {absoluteTime(event.at).replace(' UTC', '')}
          </time>
        </p>
        {payload && (
          <details className="group text-xs">
            <summary className="flex min-h-6 w-fit cursor-pointer items-center rounded text-muted-foreground transition-colors select-none hover:text-foreground">
              Payload · {Object.keys(payload).join(', ')}
            </summary>
            <pre className="code-block mt-1.5 text-xs">{JSON.stringify(payload, null, 2)}</pre>
          </details>
        )}
      </div>
    </li>
  );
}

function EventLog({ slug, liveEvents }: { slug: string; liveEvents: AuditEvent[] }) {
  const query = useProjectEvents(slug);
  const fetched = flatItems(query);
  const known = new Set(fetched.map((event) => event.id));
  const fresh = liveEvents.filter((event) => !known.has(event.id));
  const events = [...fresh, ...fetched];

  if (query.isPending) {
    return (
      <Loading label="event log">
        <SkeletonRows rows={8} className="h-10" />
      </Loading>
    );
  }
  if (query.isError) {
    return <ErrorState title="Couldn't load the event log" error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (events.length === 0) {
    return (
      <EmptyState icon={History} title="The log is empty">
        <p>Every state change for this project is appended here and never edited.</p>
      </EmptyState>
    );
  }
  return (
    <>
      <ol className="surface p-5">
        {events.map((event) => (
          <TimelineRow key={event.id} event={event} fresh={fresh.includes(event)} />
        ))}
      </ol>
      <LoadMore hasMore={query.hasNextPage} loading={query.isFetchingNextPage} onLoad={() => void query.fetchNextPage()} label="Load older events" />
    </>
  );
}

export default function AuditTab() {
  const { project, liveEvents } = useProjectContext();
  const meta = useMeta();
  const { trust } = project;
  const base = (meta.data?.base_url ?? window.location.origin).replace(/\/+$/, '');
  const fingerprint = project.pubkey_fingerprint.replace(/^SHA256:/, '');
  const cap = (value: number | null | undefined) => (value == null ? 'no cap' : <span className="num text-foreground">{formatExact(value)}</span>);

  return (
    <div className="grid min-w-0 gap-10">
      <section aria-labelledby="audit-identity" className="grid min-w-0 gap-4">
        <div>
          <h2 id="audit-identity" className="text-base font-semibold tracking-tight">
            What this instance vouches for
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            Nothing here asks for your trust. Each value comes with the command that reproduces it from the repository
            or from your own worker.
          </p>
        </div>
        {project.index_error && (
          <Notice tone="strong" icon={TriangleAlert} title="The latest commit was not indexed" role="status">
            <p>{project.index_error}</p>
          </Notice>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
          <Artifact
            icon={Fingerprint}
            title="Key fingerprint"
            value={<Grouped prefix="SHA256" hex={fingerprint} />}
            copy={project.pubkey_fingerprint}
            copyLabel="the key fingerprint"
            verify={[{ label: 'print the fingerprint on your machine', command: `${CLI_NAME} approve ${base}/${project.slug}` }]}
          >
            <p>
              Compare this with the fingerprint <code>{CLI_NAME} approve</code> prints. If they differ, do not approve:
              the key in the repository is not the one registered here.
            </p>
          </Artifact>

          <Artifact
            icon={GitCommitHorizontal}
            title="Pinned commit"
            value={project.pinned_commit}
            copy={project.pinned_commit}
            copyLabel="the pinned commit"
            link={{ href: project.commit_url ?? `${project.repo_url}/commit/${project.pinned_commit}`, label: 'View in the repository' }}
            verify={[{ label: 'check the commit exists in the repository', command: `git ls-remote ${project.repo_url} ${project.base_branch}` }]}
          >
            <p>
              The task list was read from this commit of <code>{project.base_branch}</code>. It is the commit every claim
              names.{' '}
              {project.follow_branch
                ? 'The pin follows the branch when a new head carries a valid signature.'
                : 'The pin only moves when the maintainer re-pins it.'}
            </p>
          </Artifact>

          <Artifact
            icon={KeyRound}
            title="Maintainer key"
            value={project.pubkey}
            copy={project.pubkey}
            copyLabel="the maintainer public key"
            verify={[{ label: 'verify the lock signature with stock minisign', command: `minisign -Vm tasks/MANIFEST.lock -P ${project.pubkey}` }]}
          >
            <p>Ed25519, minisign encoding. Registered when the project was created; it only changes through a signed rotation.</p>
          </Artifact>

          {project.lock_sha256 ? (
            <Artifact
              icon={FileLock2}
              title="Lock file"
              value={<Grouped prefix="sha256" hex={project.lock_sha256} />}
              copy={project.lock_sha256}
              copyLabel="the lock file hash"
              link={project.lock_url ? { href: project.lock_url, label: 'View MANIFEST.lock' } : undefined}
              verify={[{ label: 'hash the lock at the pinned commit', command: `git show ${project.pinned_commit.slice(0, 12)}:tasks/MANIFEST.lock | shasum -a 256` }]}
            >
              <p>
                SHA-256 of <code>tasks/MANIFEST.lock</code> at the pinned commit. The lock lists the hash of every task
                manifest and carries the maintainer's signature.
              </p>
            </Artifact>
          ) : (
            <EmptyState icon={FileLock2} title="No lock indexed yet">
              <p>The lock hash appears once the first signed commit has been indexed.</p>
            </EmptyState>
          )}
        </div>

        <dl className="surface grid gap-x-8 gap-y-5 p-5 text-sm sm:grid-cols-3">
          <div className="grid content-start gap-1.5">
            <dt className="label flex items-center gap-1.5">
              <ShieldCheck className="size-3.5" strokeWidth={1.5} aria-hidden="true" /> Trust tier
            </dt>
            <dd className="font-medium">
              {trust.tier === 'established' ? 'Established' : 'New'} · <span className="num">{trust.merged_tasks}</span> merged{' '}
              {trust.merged_tasks === 1 ? 'task' : 'tasks'}
            </dd>
            <dd className="text-xs text-pretty text-muted-foreground">
              Per task: {cap(trust.max_tokens_per_task)}. Per day: {cap(trust.max_tokens_per_day)}. Computed from the
              ledger; your worker applies its own limits regardless.
            </dd>
          </div>
          <div className="grid content-start gap-1.5">
            <dt className="label flex items-center gap-1.5">
              <Workflow className="size-3.5" strokeWidth={1.5} aria-hidden="true" /> CI evidence
            </dt>
            <dd className="font-medium">{project.ci_provider === 'github' ? 'GitHub checks' : 'Signed results from the project CI'}</dd>
            <dd className="text-xs text-pretty text-muted-foreground">A run is delivered only when CI passes on the exact branch and commit it pushed.</dd>
          </div>
          <div className="grid content-start gap-1.5">
            <dt className="label flex items-center gap-1.5">
              <History className="size-3.5" strokeWidth={1.5} aria-hidden="true" /> Last indexed
            </dt>
            <dd className="font-medium">{project.last_indexed_at ? <Time value={project.last_indexed_at} /> : 'Never'}</dd>
            <dd className="text-xs text-pretty text-muted-foreground">The server re-verifies the signature and every hash each time it indexes.</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="audit-log" className="grid min-w-0 gap-4">
        <div>
          <h2 id="audit-log" className="text-base font-semibold tracking-tight">
            Event log
          </h2>
          <p className="text-sm text-muted-foreground">Append-only. Rows are never updated or deleted; new ones appear live.</p>
        </div>
        <EventLog slug={project.slug} liveEvents={liveEvents} />
      </section>
    </div>
  );
}
