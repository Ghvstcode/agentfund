import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { api } from '../api/client';
import { useMe, useMeta } from '../api/queries';
import { APP_NAME, apiUrl, SOURCE_URL } from '../config';
import { session } from '../lib/session';
import { ErrorBoundary } from './ErrorBoundary';
import { SignInDialog } from './SignIn';
import { Loading, SkeletonRows } from './States';
import { ThemeToggle } from './ThemeToggle';

function Header() {
  const meta = useMeta();
  const me = useMe();
  const queryClient = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);

  const signOut = async () => {
    await api.POST('/v1/auth/logout').catch(() => undefined);
    session.clear();
    queryClient.removeQueries({ queryKey: ['me'] });
    queryClient.removeQueries({ queryKey: ['admin'] });
  };

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link to="/" className="wordmark">
          {meta.data?.name ?? APP_NAME}
        </Link>
        <nav className="site-nav" aria-label="Main">
          <NavLink to="/" end className="site-nav__link">
            Discover
          </NavLink>
          <NavLink to="/donors" className="site-nav__link">
            Donors
          </NavLink>
          <NavLink to="/maintain" className="site-nav__link">
            Maintain
          </NavLink>
          {me.data?.role === 'admin' && (
            <NavLink to="/admin" className="site-nav__link">
              Admin
            </NavLink>
          )}
        </nav>
        <div className="site-header__actions">
          <ThemeToggle />
          {me.data ? (
            <>
              <NavLink to="/settings" className="site-nav__link">
                {me.data.handle}
              </NavLink>
              <button type="button" className="link-button" onClick={() => void signOut()}>
                Sign out
              </button>
            </>
          ) : (
            <button type="button" className="link-button" onClick={() => setSigningIn(true)}>
              Sign in
            </button>
          )}
        </div>
      </div>
      {signingIn && <SignInDialog onClose={() => setSigningIn(false)} />}
    </header>
  );
}

function Footer() {
  const meta = useMeta();
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__trust">
          Trust the artifacts, not the operator. Every task is signed by its maintainer, every token is metered from a
          real run, and every state change is in a public log.
        </p>
        <div className="site-footer__meta">
          <span>
            {meta.data?.name ?? APP_NAME}
            {meta.data && (
              <>
                {' · '}
                {meta.data.app} <span className="mono">{meta.data.version}</span>
              </>
            )}
          </span>
          <nav aria-label="Footer">
            <ul className="site-footer__links">
              <li>
                <a href={apiUrl('/v1/meta')}>API</a>
              </li>
              <li>
                <a href={apiUrl('/feed.atom')}>Feed</a>
              </li>
              <li>
                <a href={SOURCE_URL} rel="noreferrer">
                  Source
                </a>
              </li>
              <li>
                <Link to="/styleguide">Styleguide</Link>
              </li>
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}

/** Scroll to the top and move focus to the main region when the page (not just a tab) changes. */
function useRouteFocus() {
  const { pathname, state } = useLocation();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const keepScroll = (state as { keepScroll?: boolean } | null)?.keepScroll === true;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (keepScroll) return;
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [pathname, keepScroll]);
  return main;
}

export function AppShell() {
  const main = useRouteFocus();
  const { pathname } = useLocation();
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <main id="main" ref={main} tabIndex={-1} className="site-main">
        <ErrorBoundary resetKey={pathname}>
          <Suspense
            fallback={
              <div className="page">
                <Loading label="page">
                  <SkeletonRows rows={6} />
                </Loading>
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <Footer />
    </>
  );
}
