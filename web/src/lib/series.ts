const DAY = 86_400_000;

export interface SeriesPoint {
  /** RFC 3339 timestamp. */
  at: string;
  tokens: number;
}

/**
 * Sum tokens into one bucket per UTC day for the `days` days ending today, oldest first.
 * Points outside the window are ignored.
 */
export function dailySeries(points: readonly SeriesPoint[], days: number, now: number = Date.now()): number[] {
  const buckets = new Array<number>(days).fill(0);
  const today = Math.floor(now / DAY);
  for (const point of points) {
    const time = Date.parse(point.at);
    if (Number.isNaN(time)) continue;
    const index = days - 1 - (today - Math.floor(time / DAY));
    if (index >= 0 && index < days) buckets[index] = (buckets[index] ?? 0) + point.tokens;
  }
  return buckets;
}

/** Running total of a series: turns per-day deliveries into a growth curve. */
export function cumulative(values: readonly number[]): number[] {
  let total = 0;
  return values.map((value) => (total += value));
}
