import { useMutation } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, unwrap } from '@/api/client';
import { useMeta } from '@/api/queries';
import { apiUrl } from '@/config';
import { session } from '@/lib/session';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { TextField } from './Field';
import { LegalLink } from './LegalLink';
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

  if (meta.isPending) return <Skeleton className="h-10" />;
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
    <div className="grid gap-5">
      {github && (
        <div className="grid gap-2.5">
          <Button variant="primary" size="lg" className="w-full" onClick={startGithubLogin}>
            Continue with GitHub
          </Button>
          <p className="text-xs text-pretty text-muted-foreground">
            Reads your GitHub profile and email address. {meta.data.name} never receives a token that can write to your
            repositories. By continuing you accept the{' '}
            <LegalLink page="terms" className="link hover:text-foreground">
              terms of use
            </LegalLink>{' '}
            and the{' '}
            <LegalLink page="privacy" className="link hover:text-foreground">
              privacy policy
            </LegalLink>
            .
          </p>
        </div>
      )}
      {dev && (
        <form className="grid gap-3 rounded-lg border border-dashed p-4" onSubmit={submit}>
          <p className="label">Dev login · development instances only</p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-start">
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
            {/* mt-5 is the label's height plus its gap: the button lines up with the input, not the label. */}
            <Button type="submit" className="h-9 sm:mt-5" busy={devLogin.isPending} busyLabel="Signing in…">
              Dev login
            </Button>
          </div>
        </form>
      )}
      {!github && !dev && <p className="text-sm text-muted-foreground">This instance has no sign-in method configured.</p>}
    </div>
  );
}

export function SignInDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Sign in" onClose={onClose} subtitle="Sign in to pledge, mint worker keys, or register a project.">
      <div className="p-5">
        <SignInPanel onSignedIn={onClose} />
      </div>
    </Dialog>
  );
}

/** Shown in place of a page that needs a session. */
export function SignInRequired({ title, reason }: { title: string; reason: string }) {
  return (
    <section className="container-page py-16 sm:py-24">
      <div className="rise mx-auto grid max-w-md gap-6">
        <span className="flex size-10 items-center justify-center rounded-lg border bg-card shadow-card">
          <Lock className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        </span>
        <header className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-pretty text-muted-foreground">{reason}</p>
        </header>
        <SignInPanel />
      </div>
    </section>
  );
}
