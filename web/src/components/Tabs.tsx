import { NavLink } from 'react-router';
import { cn } from '@/lib/utils';

/** Router state that tells the shell not to scroll to the top for this navigation. */
export const KEEP_SCROLL = { keepScroll: true } as const;

export interface TabItem {
  to: string;
  label: string;
  /** Small count shown after the label. */
  count?: number;
  /** Match the path exactly (for index tabs). */
  end?: boolean;
}

/**
 * URL-addressable section tabs: plain links, with the current one marked for assistive tech.
 * The underline grows in from the centre when a tab becomes current.
 */
export function Tabs({ label, items, className }: { label: string; items: TabItem[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn('overflow-x-auto border-b [scrollbar-width:none]', className)}>
      <ul className="flex gap-7">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              state={KEEP_SCROLL}
              className={cn(
                'group relative flex h-11 items-center gap-2 text-[0.9375rem] whitespace-nowrap text-muted-foreground transition-colors -outline-offset-2 hover:text-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground',
                'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:origin-left after:scale-x-0 after:bg-foreground after:transition-transform after:duration-200 after:ease-out aria-[current=page]:after:scale-x-100',
              )}
            >
              {item.label}
              {item.count !== undefined && <span className="num text-[0.6875rem] font-normal text-muted-foreground">{item.count}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
