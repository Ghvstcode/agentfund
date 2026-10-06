import type { Totals } from '../api/types';
import { formatCompact, formatPercent } from '../lib/format';

interface FundingBarProps {
  totals: Pick<Totals, 'pledged' | 'delivered' | 'merged' | 'in_flight'>;
  goal: number;
  /** `lg` is the project page bar; `sm` sits in cards and tables. */
  size?: 'sm' | 'lg';
}

const share = (part: number, whole: number) => `${Math.min(100, Math.max(0, (part / whole) * 100))}%`;

/**
 * Layered progress toward the token goal. A hairline track is the goal; a hairline in the
 * foreground colour is what has been pledged; the accent bar is delivered (CI passed), with
 * the merged part of it drawn solid, and running work as a lighter tail.
 */
export function FundingBar({ totals, goal, size = 'sm' }: FundingBarProps) {
  const whole = Math.max(goal, 1);
  const description =
    `${formatCompact(totals.delivered)} delivered of a ${formatCompact(goal)} token goal ` +
    `(${formatPercent(totals.delivered, goal)}); ${formatCompact(totals.pledged)} pledged, ` +
    `${formatCompact(totals.merged)} merged`;
  return (
    <div className={`funding-bar funding-bar--${size}`} role="img" aria-label={description}>
      <span className="funding-bar__pledged" style={{ width: share(totals.pledged, whole) }} />
      <span
        className="funding-bar__in-flight"
        style={{ width: share(totals.delivered + totals.in_flight, whole) }}
      />
      <span className="funding-bar__delivered" style={{ width: share(totals.delivered, whole) }} />
      <span className="funding-bar__merged" style={{ width: share(totals.merged, whole) }} />
    </div>
  );
}
