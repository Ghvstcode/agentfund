import type { ReactNode } from 'react';

/** Lets a wide table scroll sideways inside its own region instead of widening the page. */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // Scrollable regions must be reachable by keyboard.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="table-scroll" role="region" aria-label={`${label} table`} tabIndex={0}>
      {children}
    </div>
  );
}
