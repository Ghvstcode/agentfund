import type { ReactNode } from 'react';

export interface Stat {
  label: string;
  value: ReactNode;
  /** Small print under the value. */
  note?: ReactNode;
  /** Draws the matching funding-bar key next to the label. */
  swatch?: 'pledged' | 'delivered' | 'merged';
}

/** A row of labelled figures, set like the summary line of a statement. */
export function StatList({ stats, size = 'md' }: { stats: Stat[]; size?: 'md' | 'lg' }) {
  return (
    <dl className={`stats stats--${size}`}>
      {stats.map((stat) => (
        <div key={stat.label} className="stats__item">
          <dt className="stats__label">
            {stat.swatch && <span className={`swatch swatch--${stat.swatch}`} aria-hidden="true" />}
            {stat.label}
          </dt>
          <dd className="stats__value">{stat.value}</dd>
          {stat.note && <dd className="stats__note">{stat.note}</dd>}
        </div>
      ))}
    </dl>
  );
}
