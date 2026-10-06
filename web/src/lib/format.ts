const UNITS = [
  { value: 1e12, suffix: 'T' },
  { value: 1e9, suffix: 'B' },
  { value: 1e6, suffix: 'M' },
  { value: 1e3, suffix: 'K' },
] as const;

/**
 * Compact token count with three significant digits: 12.4M, 980K, 1.02B.
 * Rounds down, so a compact figure never overstates what was delivered.
 */
export function formatCompact(tokens: number): string {
  const sign = tokens < 0 ? '-' : '';
  const value = Math.abs(Math.trunc(tokens));
  const unit = UNITS.find((candidate) => value >= candidate.value);
  if (!unit) return `${sign}${value}`;
  const scaled = value / unit.value;
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const factor = 10 ** decimals;
  const floored = Math.floor(scaled * factor + 1e-9) / factor;
  // Drop trailing zeros after the decimal point only: 12.40 -> 12.4, 200 stays 200.
  const text = decimals === 0 ? String(floored) : floored.toFixed(decimals).replace(/\.?0+$/, '');
  return `${sign}${text}${unit.suffix}`;
}

/** Split an integer into groups of three digits, most significant first. */
export function digitGroups(tokens: number): string[] {
  const digits = String(Math.abs(Math.trunc(tokens)));
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups;
}

/** Exact token count with thousands separators: 12,400,000. */
export function formatExact(tokens: number, separator = ','): string {
  return `${tokens < 0 ? '-' : ''}${digitGroups(tokens).join(separator)}`;
}

/** Whole-number percentage of `part` in `whole`; 0 when there is no whole. */
export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  // Multiply first: 29 / 100 * 100 is 28.999… in floating point, 2900 / 100 is exact.
  const percent = Math.floor((part * 100) / whole);
  if (part > 0 && percent < 1) return '<1%';
  return `${percent}%`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "just now", "4m ago", "3h ago", "6d ago", then a plain date. Future times read "in 4m". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const delta = now - then;
  const size = Math.abs(delta);
  if (size < 45_000) return 'just now';
  const phrase = (amount: string) => (delta >= 0 ? `${amount} ago` : `in ${amount}`);
  if (size < HOUR) return phrase(`${Math.max(1, Math.round(size / MINUTE))}m`);
  if (size < DAY) return phrase(`${Math.round(size / HOUR)}h`);
  if (size < 30 * DAY) return phrase(`${Math.round(size / DAY)}d`);
  return DATE.format(then);
}

/** Unambiguous absolute timestamp for tooltips: 2026-10-06 18:17:04 UTC. */
export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Calendar date in UTC: 6 Oct 2026. */
export function formatDate(iso: string): string {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? '' : DATE.format(then);
}

/**
 * Shorten a hash for display, keeping any algorithm prefix: `SHA256:9f86d081…`, `2721068`.
 * The full value belongs in a title and on the clipboard.
 */
export function shortHash(hash: string, length = 7): string {
  const separator = hash.indexOf(':');
  const prefix = separator === -1 ? '' : hash.slice(0, separator + 1);
  const body = hash.slice(prefix.length);
  if (body.length <= length) return hash;
  return `${prefix}${body.slice(0, length)}${prefix ? '…' : ''}`;
}

/** 95 -> "1m 35s", 3720 -> "1h 2m". */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Parse a human token amount: "200m", "1.5M", "250k", "12,000,000". Returns null when the
 * text is not a positive whole number of tokens.
 */
export function parseTokenAmount(text: string): number | null {
  const match = /^([\d][\d,_ ]*(?:\.\d+)?)\s*([kmbt])?$/i.exec(text.trim());
  if (!match) return null;
  const multiplier = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(match[2] ?? '').toLowerCase()] ?? 1;
  const value = Number((match[1] ?? '').replace(/[,_ ]/g, '')) * multiplier;
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Turn an API enum value into a label: `verification_failed` -> "Verification failed". */
export function humanize(value: string): string {
  const words = value.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Break a long hex string into groups for reading aloud and comparing by eye. */
export function groupHex(hex: string, size = 4): string[] {
  return hex.match(new RegExp(`.{1,${size}}`, 'g')) ?? [];
}
