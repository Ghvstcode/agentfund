import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ButtonLink } from '../components/Button';
import { takeReturnPath } from '../components/SignIn';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { session, tokenFromFragment } from '../lib/session';

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

  return (
    <section className="page page--narrow" aria-live="polite">
      <header className="page__header">
        <h1>{failed ? 'Sign-in did not complete' : 'Signing you in…'}</h1>
        {failed && (
          <p className="lede">
            The sign-in response carried no session token. It may have been cancelled, or the link was opened twice.
          </p>
        )}
      </header>
      {failed && (
        <div className="button-row">
          <ButtonLink to="/" variant="primary">
            Back to projects
          </ButtonLink>
        </div>
      )}
    </section>
  );
}
