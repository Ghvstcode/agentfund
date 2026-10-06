import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { api, unwrap } from '../api/client';
import { queryKeys, useApiKeys, useMe, useMeta, useMyClaims } from '../api/queries';
import type { ApiKey, ClaimSummary } from '../api/types';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { CommandLine } from '../components/CommandLine';
import { ConfirmButton } from '../components/ConfirmButton';
import { CopyButton } from '../components/CopyButton';
import { TextField } from '../components/Field';
import { Num } from '../components/Num';
import { SignInRequired } from '../components/SignIn';
import { describeError, EmptyState, ErrorState, Loading, Notice, SkeletonRows } from '../components/States';
import { TableScroll } from '../components/TableScroll';
import { Time } from '../components/Time';
import { CLI_NAME } from '../config';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSession } from '../hooks/useSession';
import { loginCommand, loginFromStdinCommand } from '../lib/commands';
import { manifestId } from '../lib/events';
import { formatDate, humanize } from '../lib/format';

function Account() {
  const me = useMe();
  if (me.isPending) {
    return (
      <Loading label="account">
        <SkeletonRows rows={3} height="2rem" />
      </Loading>
    );
  }
  if (me.isError) return <ErrorState title="Couldn't load your account" error={me.error} onRetry={() => void me.refetch()} />;
  const user = me.data;
  return (
    <dl className="definitions definitions--wide">
      <dt>Handle</dt>
      <dd>
        <Link to={`/u/${user.handle}`}>{user.handle}</Link> <span className="muted">your public donor profile</span>
      </dd>
      <dt>Role</dt>
      <dd>{user.role}</dd>
      <dt>GitHub</dt>
      <dd>
        {user.github_login ? (
          <>
            Linked as{' '}
            <a href={`https://github.com/${user.github_login}`} rel="noreferrer">
              {user.github_login}
            </a>
          </>
        ) : (
          <span className="muted">Not linked. This account was created with dev login.</span>
        )}
      </dd>
      {user.email && (
        <>
          <dt>Email</dt>
          <dd>{user.email}</dd>
        </>
      )}
      <dt>Member since</dt>
      <dd>{formatDate(user.created_at)}</dd>
    </dl>
  );
}

function NewKey({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const meta = useMeta();
  return (
    <Notice tone="strong" title="Copy this key now. It is not shown again." role="status">
      <span className="key-line">
        <code className="key-line__value">{secret}</code>
        <CopyButton text={secret} label="the new API key" />
      </span>
      {meta.data && (
        <>
          <p>Then sign your worker in. It prompts for the key:</p>
          <CommandLine command={loginCommand(meta.data.base_url)} label="sign the worker in" />
          <p>Or, in a script, pass it on standard input:</p>
          <CommandLine command={loginFromStdinCommand(meta.data.base_url)} label="sign the worker in from a script" />
        </>
      )}
      <p className="muted">Only a hash of the key is stored. If you lose it, revoke it and create another.</p>
      <div className="button-row">
        <Button size="sm" onClick={onDismiss}>
          I've saved it
        </Button>
      </div>
    </Notice>
  );
}

function KeyRow({ apiKey }: { apiKey: ApiKey }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE('/v1/me/api-keys/{key_id}', { params: { path: { key_id: apiKey.id } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys }),
  });
  return (
    <tr>
      <th scope="row">{apiKey.label}</th>
      <td className="mono">{apiKey.prefix}…</td>
      <td>
        <Time value={apiKey.created_at} />
      </td>
      <td>{apiKey.last_used_at ? <Time value={apiKey.last_used_at} /> : <span className="muted">Never</span>}</td>
      <td className="table__actions">
        {apiKey.revoked_at ? (
          <span className="muted">
            Revoked <Time value={apiKey.revoked_at} />
          </span>
        ) : (
          <ConfirmButton
            label="Revoke"
            confirmLabel="Revoke key"
            subject={apiKey.label}
            busy={revoke.isPending}
            onConfirm={() => revoke.mutate()}
          />
        )}
        {revoke.isError && (
          <span className="table__sub" role="alert">
            {describeError(revoke.error)}
          </span>
        )}
      </td>
    </tr>
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
      <p className="muted section-note">
        A worker authenticates with an API key. Create one per machine so you can revoke them separately.
      </p>
      <form className="inline-form" onSubmit={submit}>
        <TextField
          label="Label for a new key"
          placeholder="workstation"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          required
          error={create.isError ? describeError(create.error) : null}
        />
        <Button type="submit" busy={create.isPending} busyLabel="Creating…">
          Create key
        </Button>
      </form>
      {create.data && <NewKey secret={create.data.key} onDismiss={() => create.reset()} />}

      {keys.isPending ? (
        <Loading label="API keys">
          <SkeletonRows rows={2} />
        </Loading>
      ) : keys.isError ? (
        <ErrorState title="Couldn't load your keys" error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.items.length === 0 ? (
        <EmptyState title="No API keys yet">
          <p>
            Create one above, then run <code>{CLI_NAME} login</code> on the machine that will do the work.
          </p>
        </EmptyState>
      ) : (
        <TableScroll label="API keys">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Key</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.data.items.map((apiKey) => (
                <KeyRow key={apiKey.id} apiKey={apiKey} />
              ))}
            </tbody>
          </table>
        </TableScroll>
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
      <Loading label="claims">
        <SkeletonRows rows={4} />
      </Loading>
    );
  }
  if (claims.isError) return <ErrorState title="Couldn't load your claims" error={claims.error} onRetry={() => void claims.refetch()} />;
  if (claims.data.items.length === 0) {
    return (
      <EmptyState title="No claims yet">
        <p>When your worker claims a task it shows up here, with what it burned and whether CI confirmed it.</p>
      </EmptyState>
    );
  }
  return (
    <TableScroll label="Your recent claims">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="table__num">
              Tokens
            </th>
            <th scope="col">Claimed</th>
          </tr>
        </thead>
        <tbody>
          {claims.data.items.map((claim) => (
            <tr key={claim.claim_id}>
              <td>
                <Link to={`/${claim.project}/tasks/${manifestId(claim.task_id)}`} className="mono">
                  {manifestId(claim.task_id)}
                </Link>
                <span className="table__sub">
                  <Link to={`/${claim.project}`}>{claim.project}</Link>
                </span>
              </td>
              <td>{claim.status === 'active' ? <Badge tone="live">Running</Badge> : claimOutcome(claim)}</td>
              <td className="table__num">
                {claim.report ? <Num value={claim.report.tokens_in + claim.report.tokens_out} /> : '—'}
              </td>
              <td>
                <Time value={claim.claimed_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export default function Settings() {
  useDocumentTitle('Settings');
  const token = useSession();
  if (!token) {
    return <SignInRequired title="Settings" reason="Sign in to manage your account and the API keys your workers use." />;
  }
  return (
    <div className="page page--medium settings">
      <header className="page__header">
        <h1>Settings</h1>
      </header>
      <section className="settings__section" aria-labelledby="settings-account">
        <h2 id="settings-account">Account</h2>
        <Account />
      </section>
      <section className="settings__section" aria-labelledby="settings-keys">
        <h2 id="settings-keys">API keys</h2>
        <ApiKeys />
      </section>
      <section className="settings__section" aria-labelledby="settings-claims">
        <h2 id="settings-claims">Recent claims</h2>
        <Claims />
      </section>
    </div>
  );
}
