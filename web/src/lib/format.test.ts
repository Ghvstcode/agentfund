import { describe, expect, it } from 'vitest';
import {
  absoluteTime,
  digitGroups,
  formatCompact,
  formatDuration,
  formatExact,
  formatPercent,
  humanize,
  parseTokenAmount,
  relativeTime,
  shortHash,
} from './format';

describe('formatCompact', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [1250, '1.25K'],
    [12_400, '12.4K'],
    [980_000, '980K'],
    [12_400_000, '12.4M'],
    [60_000_000, '60M'],
    [200_000_000, '200M'],
    [1_020_000_000, '1.02B'],
    [3_000_000_000_000, '3T'],
  ])('%d -> %s', (input, expected) => {
    expect(formatCompact(input)).toBe(expected);
  });

  it('rounds down so a figure never overstates', () => {
    expect(formatCompact(999_999)).toBe('999K');
    expect(formatCompact(12_499_999)).toBe('12.4M');
    expect(formatCompact(1_999_999_999)).toBe('1.99B');
  });

  it('keeps the sign', () => {
    expect(formatCompact(-1500)).toBe('-1.5K');
  });
});

describe('formatExact', () => {
  it('groups thousands', () => {
    expect(formatExact(0)).toBe('0');
    expect(formatExact(999)).toBe('999');
    expect(formatExact(1000)).toBe('1,000');
    expect(formatExact(12_400_000)).toBe('12,400,000');
    expect(formatExact(1_234_567, ' ')).toBe('1 234 567');
  });

  it('splits into groups for the counter', () => {
    expect(digitGroups(1_234_567)).toEqual(['1', '234', '567']);
    expect(digitGroups(42)).toEqual(['42']);
  });
});

describe('formatPercent', () => {
  it('floors and handles the edges', () => {
    expect(formatPercent(29, 100)).toBe('29%');
    expect(formatPercent(299, 1000)).toBe('29%');
    expect(formatPercent(1, 1000)).toBe('<1%');
    expect(formatPercent(0, 1000)).toBe('0%');
    expect(formatPercent(5, 0)).toBe('0%');
    expect(formatPercent(111, 100)).toBe('111%');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  it.each([
    ['2026-10-06T11:59:40Z', 'just now'],
    ['2026-10-06T11:56:00Z', '4m ago'],
    ['2026-10-06T09:00:00Z', '3h ago'],
    ['2026-09-30T12:00:00Z', '6d ago'],
    ['2026-08-01T12:00:00Z', '1 Aug 2026'],
    ['2026-10-06T12:30:00Z', 'in 30m'],
  ])('%s -> %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it('returns an empty string for an invalid date', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });

  it('pairs with an absolute UTC timestamp for the title', () => {
    expect(absoluteTime('2026-10-06T18:17:04.920Z')).toBe('2026-10-06 18:17:04 UTC');
  });
});

describe('shortHash', () => {
  it('shortens bare hashes', () => {
    expect(shortHash('2721068a7775bcc9f2fd134fc2b7a1f6584071ff')).toBe('2721068');
    expect(shortHash('abc')).toBe('abc');
  });

  it('keeps an algorithm prefix and marks the cut', () => {
    expect(shortHash('SHA256:9f86d081884c7d659a2feaa0c55ad015', 8)).toBe('SHA256:9f86d081…');
  });
});

describe('parseTokenAmount', () => {
  it.each([
    ['200m', 200_000_000],
    ['1.5M', 1_500_000],
    ['250k', 250_000],
    ['12,000,000', 12_000_000],
    [' 42 ', 42],
    ['2b', 2_000_000_000],
  ])('%s -> %d', (text, expected) => {
    expect(parseTokenAmount(text)).toBe(expected);
  });

  it.each(['', '0', '-5', 'abc', '1.5', '2 many', '1.2345k'])('rejects %j', (text) => {
    expect(parseTokenAmount(text)).toBeNull();
  });
});

describe('small formatters', () => {
  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(95)).toBe('1m 35s');
    expect(formatDuration(3720)).toBe('1h 2m');
  });

  it('humanizes enum values', () => {
    expect(humanize('verification_failed')).toBe('Verification failed');
  });
});
