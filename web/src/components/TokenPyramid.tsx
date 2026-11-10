import { type CSSProperties, useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import type { TokenState } from './Mark';

const ROWS = 7;
const PITCH = 46;
const RADIUS = 20.5;
/** How often a token moves up a state, and how long it stays there. */
const PROMOTE_EVERY_MS = 1800;
const PROMOTION_MS = 2600;

/** Fixed, illustrative states, top row first: green on top is what counted. Not live data. */
const STATES: TokenState[] = [
  ...Array<TokenState>(6).fill('delivered'),
  ...Array<TokenState>(4).fill('merged'),
  ...Array<TokenState>(6).fill('reported'),
  ...Array<TokenState>(12).fill('pledged'),
];
const NEXT: Partial<Record<TokenState, TokenState>> = { pledged: 'reported', reported: 'delivered' };
const promotable = (state: TokenState) =>
  STATES.flatMap((current, index) => (current === state ? [index] : []));
const PLEDGED = promotable('pledged');
const REPORTED = promotable('reported');

const pick = (indexes: number[]) => indexes[Math.floor(Math.random() * indexes.length)] ?? 0;

/**
 * Tokens that are briefly one state further along: every so often a pledged ring fills in
 * and a reported token turns green, then settles back, so the pile reads as work in motion.
 */
function usePromotions(enabled: boolean): Set<number> {
  const [promoted, setPromoted] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    if (!enabled) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const tick = () => {
      const batch = [pick(PLEDGED), pick(REPORTED)];
      setPromoted((current) => new Set([...current, ...batch]));
      timers.push(
        setTimeout(() => {
          setPromoted((current) => new Set([...current].filter((index) => !batch.includes(index))));
        }, PROMOTION_MS),
      );
    };
    const start = setTimeout(tick, 2200);
    const interval = setInterval(tick, PROMOTE_EVERY_MS);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
      timers.forEach(clearTimeout);
    };
  }, [enabled]);
  return promoted;
}

/**
 * The home page's emblem: the mark's lattice grown into a pile of tokens in the four ledger
 * states. It builds from the bottom on load, a wave lifts it toward the green top every few
 * seconds, and tokens step up a state now and then. All motion stops for reduced motion.
 */
export function TokenPyramid({ className }: { className?: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const promoted = usePromotions(!reducedMotion);
  const width = ROWS * PITCH;
  const rowHeight = (PITCH * Math.sqrt(3)) / 2;
  const height = (ROWS - 1) * rowHeight + PITCH;
  const total = STATES.length;

  let index = 0;
  const tokens = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      const lift = promoted.has(index);
      const state = (lift && NEXT[STATES[index] ?? 'pledged']) || STATES[index];
      const cx = width / 2 + (column - row / 2) * PITCH;
      const cy = PITCH / 2 + row * rowHeight;
      tokens.push(
        // Build order runs from the bottom-left, so the pile grows upward.
        <g key={index} className={cn(!reducedMotion && 'pyramid-slot')} style={{ '--order': total - 1 - index } as CSSProperties}>
          {index === 0 && !reducedMotion && (
            <circle cx={cx} cy={cy} r={RADIUS} className="pyramid-ripple fill-none stroke-pass [stroke-width:2]" />
          )}
          <circle
            cx={cx}
            cy={cy}
            r={state === 'pledged' ? RADIUS - 1 : RADIUS}
            data-promoted={lift || undefined}
            style={{ '--row': row } as CSSProperties}
            className={cn(
              !reducedMotion && 'pyramid-token',
              state === 'pledged' && 'fill-transparent stroke-input [stroke-width:1.5]',
              state === 'reported' && 'fill-muted-foreground stroke-transparent',
              state === 'delivered' && 'fill-pass stroke-transparent',
              state === 'merged' && 'fill-foreground stroke-transparent',
            )}
          />
        </g>,
      );
      index += 1;
    }
  }

  return (
    <svg viewBox={`-24 -24 ${width + 48} ${height + 48}`} aria-hidden="true" className={cn('h-auto w-full overflow-visible', className)}>
      {tokens}
    </svg>
  );
}
