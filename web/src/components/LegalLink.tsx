import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useMeta } from '@/api/queries';
import { instanceLinks } from '@/lib/commands';

export type LegalPage = 'privacy' | 'terms';

/** Where a policy lives: the operator's own page when configured, else the built-in route. */
export function useLegalHref(page: LegalPage): { href: string; external: boolean } {
  const links = instanceLinks(useMeta().data);
  const url = page === 'privacy' ? links.privacyUrl : links.termsUrl;
  return url ? { href: url, external: true } : { href: `/${page}`, external: false };
}

export function LegalLink({ page, className, children }: { page: LegalPage; className?: string; children: ReactNode }) {
  const { href, external } = useLegalHref(page);
  return external ? (
    <a href={href} rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link to={href} className={className}>
      {children}
    </Link>
  );
}
