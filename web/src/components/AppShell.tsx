import { Search, Zap } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useMe, useMeta } from '@/api/queries';
import { APP_NAME, apiUrl } from '@/config';
import { instanceLinks } from '@/lib/commands';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { ErrorBoundary } from './ErrorBoundary';
import { UserPill } from './UserPill';
import { Loading, SkeletonRows } from './States';
import { ThemeToggle } from './ThemeToggle';

// Overlays are fetched when first needed, keeping Radix out of the first paint.
const CommandPalette = lazy(() => import('./CommandPalette'));
const UserMenu = lazy(() => import('./UserMenu'));
const SignInDialog = lazy(() => import('./SignIn').then((module) => ({ default: module.SignInDialog })));

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function NavItem({ to, end, children }: { to: string; end?: boolean; children: string }) {
  return (
    <NavLink
      to={to}
      end={end}
      className="flex h-8 items-center rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
    >
      {children}
    </NavLink>
  );
}

function Header({ onOpenPalette }: { onOpenPalette: () => void }) {
  const meta = useMeta();
  const me = useMe();
  const [signingIn, setSigningIn] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b bg-background/75 backdrop-blur-xl backdrop-saturate-150">
      <div className="container-page flex h-14 items-center gap-2">
        <Link to="/" className="mr-2 flex items-center gap-2 rounded-md text-[0.9375rem] font-semibold tracking-tight">
          <span className="flex size-6 items-center justify-center rounded-md bg-foreground text-background shadow-card">
            <Zap className="size-3.5 fill-current" strokeWidth={0} aria-hidden="true" />
          </span>
          <span className="max-w-40 truncate sm:max-w-none">{meta.data?.name ?? APP_NAME}</span>
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-0.5 md:flex">
          <NavItem to="/" end>
            Discover
          </NavItem>
          <NavItem to="/donors">Donors</NavItem>
          <NavItem to="/maintain">Maintain</NavItem>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label="Search projects, donors and pages"
            aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
            className="flex h-8 items-center gap-2 rounded-lg border bg-card px-2.5 text-sm text-muted-foreground shadow-card transition-colors hover:text-foreground sm:w-56"
          >
            <Search className="size-4" strokeWidth={1.5} aria-hidden="true" />
            <span className="hidden flex-1 text-left sm:inline">Search…</span>
            <kbd className="hidden rounded border bg-muted px-1.5 text-[0.6875rem] leading-5 font-medium sm:inline">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <ThemeToggle />
          {me.data ? (
            <Suspense fallback={<UserPill handle={me.data.handle} disabled />}>
              <UserMenu handle={me.data.handle} admin={me.data.role === 'admin'} />
            </Suspense>
          ) : (
            <Button variant="primary" onClick={() => setSigningIn(true)}>
              Sign in
            </Button>
          )}
        </div>
      </div>
      <nav aria-label="Main, compact" className="container-page flex gap-0.5 overflow-x-auto border-t py-1.5 [scrollbar-width:none] md:hidden">
        <NavItem to="/" end>
          Discover
        </NavItem>
        <NavItem to="/donors">Donors</NavItem>
        <NavItem to="/maintain">Maintain</NavItem>
      </nav>
      {signingIn && (
        <Suspense fallback={null}>
          <SignInDialog onClose={() => setSigningIn(false)} />
        </Suspense>
      )}
    </header>
  );
}

function Footer() {
  const meta = useMeta();
  const links = instanceLinks(meta.data);
  const items = [
    { href: apiUrl('/v1/meta'), label: 'API' },
    { href: apiUrl('/feed.atom'), label: 'Feed' },
    { href: links.sourceUrl, label: 'Source' },
    ...(links.docsUrl ? [{ href: links.docsUrl, label: 'Docs' }] : []),
  ];
  return (
    <footer className="mt-24 border-t">
      <div className="container-page grid gap-6 py-10 text-sm text-muted-foreground md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-2">
          <p className="font-medium text-foreground">Trust the artifacts, not the operator.</p>
          <p className="max-w-xl text-pretty">
            Every task is signed by its maintainer, every token is metered from a real run, and every state change is
            in a public log.
          </p>
        </div>
        <div className="grid gap-3 md:justify-items-end">
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              {items.map((item) => (
                <li key={item.label}>
                  <a href={item.href} rel="noreferrer" className="inline-block py-1 transition-colors hover:text-foreground">
                    {item.label}
                  </a>
                </li>
              ))}
              <li>
                <Link to="/styleguide" className="inline-block py-1 transition-colors hover:text-foreground">
                  Styleguide
                </Link>
              </li>
            </ul>
          </nav>
          <p className="text-xs">
            {meta.data?.name ?? APP_NAME}
            {meta.data && (
              <>
                {' · '}
                {/* Name the software only when the instance goes by another name. */}
                {meta.data.app !== meta.data.name && `${meta.data.app} `}
                <span className="num">{meta.data.version}</span>
              </>
            )}
          </p>
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

/** ⌘K / Ctrl+K anywhere; "/" too, unless the page has its own search field to focus. */
function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable]');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      } else if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const field = document.querySelector<HTMLInputElement>('[data-slash-focus]');
        event.preventDefault();
        if (field) field.focus();
        else open();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);
}

export function AppShell() {
  const main = useRouteFocus();
  const { pathname } = useLocation();
  const [palette, setPalette] = useState(false);
  const openPalette = useRef(() => setPalette(true)).current;
  usePaletteShortcut(openPalette);

  return (
    <>
      <a
        href="#main"
        className={cn(
          'fixed top-3 left-3 z-50 -translate-y-20 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background transition-transform focus:translate-y-0',
        )}
      >
        Skip to content
      </a>
      <Header onOpenPalette={openPalette} />
      <main id="main" ref={main} tabIndex={-1} className="min-h-[calc(100dvh-3.5rem)] outline-none">
        <ErrorBoundary resetKey={pathname}>
          <Suspense
            fallback={
              <div className="container-page py-10">
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
      {palette && (
        <Suspense fallback={null}>
          <CommandPalette onClose={() => setPalette(false)} />
        </Suspense>
      )}
    </>
  );
}
