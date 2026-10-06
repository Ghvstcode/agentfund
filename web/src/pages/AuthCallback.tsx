import { Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ButtonLink } from '@/components/Button';
import { takeReturnPath } from '@/components/SignIn';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { session, tokenFromFragment } from '@/lib/session';

/** Landing route of the OAuth redirect: stores the token from `#token=` and moves on. */
export default function AuthCallback() {
  useDocumentTitle('Signing in');
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const token = tokenFromFragment(window.location.hash);
    if (!token) {
      setFailed(true);
      return;
    }
    session.setToken(token);
    // Replace the entry so the token does not linger in history.
    void navigate(takeReturnPath(), { replace: true });
  }, [navigate]);

  const Icon = failed ? ShieldAlert : Loader2;

  return (
    <section className="container-page py-16 sm:py-24" aria-live="polite">
      <div className="mx-auto grid max-w-md gap-5">
        <span className="flex size-10 items-center justify-center rounded-lg border bg-card shadow-card">
          <Icon className={failed ? 'size-4 text-muted-foreground' : 'size-4 animate-spin text-muted-foreground'} strokeWidth={1.5} aria-hidden="true" />
        </span>
        <header className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{failed ? 'Sign-in did not complete' : 'Signing you in…'}</h1>
          {failed && (
            <p className="text-sm text-pretty text-muted-foreground">
              The sign-in response carried no session token. It may have been cancelled, or the link was opened twice.
            </p>
          )}
        </header>
        {failed && (
          <div className="flex flex-wrap gap-2">
            <ButtonLink to="/" variant="primary">
              Back to projects
            </ButtonLink>
          </div>
        )}
      </div>
    </section>
  );
}
