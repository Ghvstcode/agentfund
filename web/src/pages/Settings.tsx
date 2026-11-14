import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, ListChecks } from 'lucide-react';
import { type CSSProperties, type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { api, unwrap } from '@/api/client';
import { queryKeys, useApiKeys, useMe, useMeta, useMyClaims } from '@/api/queries';
import type { ApiKey, ClaimSummary } from '@/api/types';
import { Button } from '@/components/Button';
import { CommandLine } from '@/components/CommandLine';
import { ConfirmButton } from '@/components/ConfirmButton';
import { CopyButton } from '@/components/CopyButton';
import { TextField } from '@/components/Field';
import { HandleAvatar } from '@/components/HandleAvatar';
import { Num } from '@/components/Num';
import { SignInRequired } from '@/components/SignIn';
import { describeError, EmptyState, ErrorState, Loading, SkeletonRows } from '@/components/States';
import { Time } from '@/components/Time';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CLI_NAME } from '@/config';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useSession } from '@/hooks/useSession';
import { loginCommand, loginFromStdinCommand } from '@/lib/commands';
import { manifestId } from '@/lib/events';
import { formatDate, humanize } from '@/lib/format';
import { profilePath } from '@/lib/handles';

const COLUMN = 'h-9 text-xs font-medium text-muted-foreground';

interface CardProps {
  id: string;
  title: string;
  description?: string;
  index: number;
  children: ReactNode;
}

/** One settings group: a titled card that enters after the one above it. */
function Card({ id, title, description, index, children }: CardProps) {
  return (
    <section className="surface rise overflow-hidden" style={{ '--i': index } as CSSProperties} aria-labelledby={id}>
      <div className="grid gap-1 border-b px-5 py-4">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description && <p className="max-w-prose text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function Account() {
  const me = useMe();
  if (me.isPending) {
    return (
      <Loading label="account" className="p-5">
        <SkeletonRows rows={3} className="h-8" />
      </Loading>
    );
  }
  if (me.isError) {
    return <ErrorState className="m-5" title="Couldn't load your account" error={me.error} onRetry={() => void me.refetch()} />;
  }
  const user = me.data;
  return (
    <>
      <div className="flex items-center gap-4 border-b p-5">
        <HandleAvatar handle={user.handle} className="size-12 text-lg" />
        <div className="grid min-w-0 gap-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold tracking-tight">{user.handle}</span>
            <Badge variant="outline">{humanize(user.role)}</Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            <Link to={profilePath(user.handle)} className="link">
              Your public donor profile
            </Link>
          </p>
        </div>
      </div>
      <dl className="divide-y">
        <Detail label="GitHub">
          {user.github_login ? (
            <>
              Linked as{' '}
              <a href={`https://github.com/${user.github_login}`} rel="noreferrer" className="link inline-flex items-center gap-1 font-medium">
                {user.github_login}
                <ExternalLink className="size-3.5 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
              </a>
            </>
          ) : (
            <span className="text-muted-foreground">Not linked. This account was created with dev login.</span>
          )}
        </Detail>
        {user.email && <Detail label="Email">{user.email}</Detail>}
        <Detail label="Member since">
          <span className="tabular-nums">{formatDate(user.created_at)}</span>
        </Detail>
      </dl>
    </>
  );
}

/** Shown once, straight after a key is minted: the only time the secret is readable. */
function NewKey({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const meta = useMeta();
  return (
    <div role="status" className="overflow-hidden rounded-xl border border-foreground/25 bg-muted/40 shadow-card">
      <div className="grid gap-4 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card shadow-card">
            <KeyRound className="size-4" strokeWidth={1.5} aria-hidden="true" />
          </span>
          <div className="grid gap-0.5">
            <p className="text-sm font-semibold">Copy this key now. It is not shown again.</p>
            <p className="text-sm text-muted-foreground">Only a hash of the key is stored. If you lose it, revoke it and create another.</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-input bg-background py-1.5 pr-1.5 pl-3">
          <code className="num min-w-0 flex-1 text-[0.8125rem] break-all">{secret}</code>
          <CopyButton text={secret} label="the new API key" caption="Copy" />
        </div>
        {meta.data && (
          <div className="grid gap-2 text-sm text-muted-foreground">
            <p>Then sign your worker in. It prompts for the key:</p>
            <CommandLine command={loginCommand(meta.data.base_url)} label="sign the worker in" />
            <p className="pt-1">Or, in a script, pass it on standard input:</p>
            <CommandLine command={loginFromStdinCommand(meta.data.base_url)} label="sign the worker in from a script" />
          </div>
        )}
      </div>
      <div className="flex justify-end border-t border-foreground/10 px-5 py-3">
        <Button size="sm" variant="primary" onClick={onDismiss}>
          I've saved it
        </Button>
      </div>
    </div>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/me/api-keys/{key_id}', { params: { path: { key_id: apiKey.id } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys }),
  });
  return (
    <TableRow className="hover:bg-muted/40">
      <TableHead scope="row" className="pl-5">
        {apiKey.label}
      </TableHead>
      <TableCell className="num text-[0.8125rem] text-muted-foreground">{apiKey.prefix}…</TableCell>
      <TableCell className="hidden sm:table-cell text-muted-foreground">
        <Time value={apiKey.created_at} />
      </TableCell>
      <TableCell className="hidden sm:table-cell text-muted-foreground">{apiKey.last_used_at ? <Time value={apiKey.last_used_at} /> : 'Never'}</TableCell>
      <TableCell className="pr-5 text-right">
        {apiKey.revoked_at ? (
          <span className="text-xs text-muted-foreground">
            Revoked <Time value={apiKey.revoked_at} />
          </span>
        ) : (
          <ConfirmButton label="Revoke" confirmLabel="Revoke key" subject={apiKey.label} busy={revoke.isPending} onConfirm={() => revoke.mutate()} />
        )}
        {revoke.isError && (
          <span className="mt-1 block text-xs font-medium text-destructive" role="alert">
            {describeError(revoke.error)}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

function ApiKeys() {
  const keys = useApiKeys();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const create = useMutation({
    mutationFn: (value: string) => unwrap(api.POST('/v1/me/api-keys', { body: { label: value } })),
    onSuccess: () => {
      setLabel('');
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (label.trim()) create.mutate(label.trim());
  };

  return (
    <>
      <div className="grid gap-4 border-b p-5">
        <form className="grid gap-2 sm:grid-cols-[minmax(0,20rem)_auto] sm:items-start" onSubmit={submit}>
          <TextField
            label="Label for a new key"
            placeholder="workstation"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={80}
            required
            error={create.isError ? describeError(create.error) : null}
          />
          {/* mt-5 is the label's height plus its gap: the button lines up with the input. */}
          <Button type="submit" className="h-9 justify-self-start sm:mt-5" busy={create.isPending} busyLabel="Creating…">
            <KeyRound strokeWidth={1.5} aria-hidden="true" />
            Create key
          </Button>
        </form>
        {create.data && <NewKey secret={create.data.key} onDismiss={() => create.reset()} />}
      </div>

      {keys.isPending ? (
        <Loading label="API keys" className="p-5">
          <SkeletonRows rows={2} />
        </Loading>
      ) : keys.isError ? (
        <ErrorState className="m-5" title="Couldn't load your keys" error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.items.length === 0 ? (
        <EmptyState className="m-5" title="No API keys yet" icon={KeyRound}>
          <p>
            Create one above, then run <code>{CLI_NAME} login</code> on the machine that will do the work.
          </p>
        </EmptyState>
      ) : (
        <Table aria-label="API keys">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={`${COLUMN} pl-5`}>
                Label
              </TableHead>
              <TableHead scope="col" className={COLUMN}>
                Key
              </TableHead>
              <TableHead scope="col" className={`${COLUMN} hidden sm:table-cell`}>
                Created
              </TableHead>
              <TableHead scope="col" className={`${COLUMN} hidden sm:table-cell`}>
                Last used
              </TableHead>
              <TableHead scope="col" className={`${COLUMN} pr-5`}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data.items.map((apiKey) => (
              <KeyRow key={apiKey.id} apiKey={apiKey} />
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

const CLAIM_STATUS: Record<ClaimSummary['status'], string> = {
  active: 'Running',
  reported: 'Reported',
  released: 'Released',
  expired: 'Lease expired',
};

function claimOutcome(claim: ClaimSummary): string {
  const report = claim.report;
  if (!report) return CLAIM_STATUS[claim.status];
  if (report.status !== 'completed') return humanize(report.status);
  return { none: 'Reported', pending_ci: 'Awaiting CI', ci_failed: 'CI failed', delivered: 'Delivered', merged: 'Merged', closed: 'PR closed' }[
    report.delivery
  ];
}

function Claims() {
  const claims = useMyClaims();
  if (claims.isPending) {
    return (
      <Loading label="claims" className="p-5">
        <SkeletonRows rows={4} />
      </Loading>
    );
  }
  if (claims.isError) {
    return <ErrorState className="m-5" title="Couldn't load your claims" error={claims.error} onRetry={() => void claims.refetch()} />;
  }
  if (claims.data.items.length === 0) {
    return (
      <EmptyState className="m-5" title="No claims yet" icon={ListChecks}>
        <p>When your worker claims a task it shows up here, with what it burned and whether CI confirmed it.</p>
      </EmptyState>
    );
  }
  return (
    <Table aria-label="Your recent claims">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${COLUMN} pl-5`}>
            Task
          </TableHead>
          <TableHead scope="col" className={COLUMN}>
            Outcome
          </TableHead>
          <TableHead scope="col" className={`${COLUMN} text-right`}>
            Tokens
          </TableHead>
          <TableHead scope="col" className={`${COLUMN} pr-5 text-right`}>
            Claimed
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {claims.data.items.map((claim) => (
          <TableRow key={claim.claim_id} className="hover:bg-muted/40">
            <TableCell className="py-2.5 pl-5">
              <Link
                to={`/${claim.project}/tasks/${manifestId(claim.task_id)}`}
                className="num block py-1 text-[0.8125rem] font-medium underline-offset-4 hover:underline"
              >
                {manifestId(claim.task_id)}
              </Link>
              <Link to={`/${claim.project}`} className="inline-block py-1 text-xs text-muted-foreground underline-offset-4 hover:underline">
                {claim.project}
              </Link>
            </TableCell>
            <TableCell>
              {claim.status === 'active' ? (
                <Badge variant="outline" className="gap-1.5 border-live/25 bg-live/8 text-live">
                  <span className="live-dot size-1.5" aria-hidden="true" />
                  Running
                </Badge>
              ) : (
                claimOutcome(claim)
              )}
            </TableCell>
            <TableCell className="text-right">
              {claim.report ? <Num value={claim.report.tokens_in + claim.report.tokens_out} /> : <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell className="pr-5 text-right text-muted-foreground">
              <Time value={claim.claimed_at} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function Settings() {
  useDocumentTitle('Settings');
  const token = useSession();
  if (!token) {
    return <SignInRequired title="Settings" reason="Sign in to manage your account and the API keys your workers use." />;
  }
  return (
    <div className="container-page py-10">
      <div className="mx-auto grid max-w-3xl gap-6">
        <header className="rise mb-2 grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="max-w-prose text-sm text-muted-foreground">Your account, the keys your workers sign in with, and what they claimed.</p>
        </header>
        <Card id="settings-account" title="Account" index={1}>
          <Account />
        </Card>
        <Card
          id="settings-keys"
          title="API keys"
          description="A worker authenticates with an API key. Create one per machine so you can revoke them separately."
          index={2}
        >
          <ApiKeys />
        </Card>
        <Card id="settings-claims" title="Recent claims" index={3}>
          <Claims />
        </Card>
      </div>
    </div>
  );
}
