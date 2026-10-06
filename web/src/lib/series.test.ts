import { describe, expect, it } from 'vitest';
import { sparklinePoints } from '@/components/Sparkline';
import { cumulative, dailySeries } from './series';

const NOW = Date.parse('2026-10-06T12:00:00Z');

describe('dailySeries', () => {
  it('sums tokens into UTC-day buckets, oldest first, ending today', () => {
    const series = dailySeries(
      [
        { at: '2026-10-06T01:00:00Z', tokens: 5 },
        { at: '2026-10-06T23:59:59Z', tokens: 7 },
        { at: '2026-10-05T10:00:00Z', tokens: 3 },
        { at: '2026-10-03T00:00:00Z', tokens: 11 },
      ],
      4,
      NOW,
    );
    expect(series).toEqual([11, 0, 3, 12]);
  });

  it('ignores points outside the window and unparseable dates', () => {
    const series = dailySeries(
      [
        { at: '2026-09-01T00:00:00Z', tokens: 99 },
        { at: '2026-10-09T00:00:00Z', tokens: 99 },
        { at: 'not a date', tokens: 99 },
      ],
      3,
      NOW,
    );
    expect(series).toEqual([0, 0, 0]);
  });

  it('accumulates into a growth curve', () => {
    expect(cumulative([0, 2, 0, 5])).toEqual([0, 2, 2, 7]);
  });
});

describe('sparklinePoints', () => {
  it('spreads points across the width and scales the peak to the top', () => {
    const points = sparklinePoints([0, 5, 10]);
    expect(points.map(([x]) => x)).toEqual([0, 50, 100]);
    expect(points[2]?.[1]).toBeLessThan(points[1]?.[1] ?? 0);
    expect(points[0]?.[1]).toBeGreaterThan(points[1]?.[1] ?? 0);
  });

  it('keeps a flat or empty series on the baseline without dividing by zero', () => {
    expect(sparklinePoints([])).toEqual([]);
    const flat = sparklinePoints([0, 0, 0]);
    expect(new Set(flat.map(([, y]) => y)).size).toBe(1);
    expect(flat.every(([, y]) => Number.isFinite(y))).toBe(true);
  });
});
