import { NavLink } from 'react-router';

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

/** URL-addressable section tabs: plain links, with the current one marked for assistive tech. */
export function Tabs({ label, items }: { label: string; items: TabItem[] }) {
  return (
    <nav className="tabs" aria-label={label}>
      <ul className="tabs__list">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end} className="tabs__tab" state={KEEP_SCROLL}>
              {item.label}
              {item.count !== undefined && <span className="tabs__count mono">{item.count}</span>}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
