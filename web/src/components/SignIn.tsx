import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, unwrap } from '../api/client';
import { useMeta } from '../api/queries';
import { apiUrl } from '../config';
import { session } from '../lib/session';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { TextField } from './Field';
import { describeError, Notice, Skeleton } from './States';

const RETURN_KEY = 'agentfund.return_to';

/** Where the OAuth callback should send the visitor once signed in. */
export function takeReturnPath(): string {
  try {
    const path = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    return path?.startsWith('/') ? path : '/';
  } catch {
    return '/';
  }
}

function startGithubLogin() {
  try {
    window.sessionStorage.setItem(RETURN_KEY, window.location.pathname);
  } catch {
    // Without storage the callback lands on the home page.
  }
  const redirect = encodeURIComponent(`${window.location.origin}/auth/callback`);
  window.location.assign(`${apiUrl('/v1/auth/github/start')}?redirect=${redirect}`);
}

/** Sign-in options the instance offers: GitHub, and a labelled dev login when enabled. */
export function SignInPanel({ onSignedIn }: { onSignedIn?: () => void }) {
  const meta = useMeta();
  const [handle, setHandle] = useState('');
  const devLogin = useMutation({
    mutationFn: (value: string) => unwrap(api.POST('/v1/auth/dev', { body: { handle: value } })),
    onSuccess: ({ token }) => {
      session.setToken(token);
      onSignedIn?.();
    },
  });

  if (meta.isPending) return <Skeleton height="2.5rem" />;
  if (meta.isError) {
    return (
      <Notice tone="strong" role="alert" title="Sign-in is unavailable">
        {describeError(meta.error)}
      </Notice>
    );
  }

  const { github_oauth: github, dev_login: dev } = meta.data.capabilities;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    devLogin.mutate(handle.trim().toLowerCase());
  };

  return (
    <div className="sign-in">
      {github && (
        <div className="sign-in__option">
          <Button variant="primary" onClick={startGithubLogin}>
            Continue with GitHub
          </Button>
          <p className="muted">
            Read-only access to your public profile. {meta.data.name} never receives a token that can write to your
            repositories.
          </p>
        </div>
      )}
      {dev && (
        <form className="sign-in__option sign-in__dev" onSubmit={submit}>
          <p className="eyebrow">Dev login · development instances only</p>
          <div className="inline-form">
            <TextField
              label="Handle"
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="ada"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              pattern="[a-z0-9][a-z0-9\-]{0,38}"
              error={devLogin.isError ? describeError(devLogin.error) : null}
              hint="Signs you in as any handle without GitHub. Never enable this in production."
            />
            <Button type="submit" busy={devLogin.isPending} busyLabel="Signing in…">
              Dev login
            </Button>
          </div>
        </form>
      )}
      {!github && !dev && <p className="muted">This instance has no sign-in method configured.</p>}
    </div>
  );
}

export function SignInDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Sign in" onClose={onClose} subtitle="Sign in to pledge, mint worker keys, or register a project.">
      <SignInPanel onSignedIn={onClose} />
    </Dialog>
  );
}

/** Shown in place of a page that needs a session. */
export function SignInRequired({ title, reason }: { title: string; reason: string }) {
  return (
    <section className="page page--narrow">
      <header className="page__header">
        <h1>{title}</h1>
        <p className="lede">{reason}</p>
      </header>
      <SignInPanel />
    </section>
  );
}
