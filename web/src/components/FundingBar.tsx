import type { Totals } from '@/api/types';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatCompact, formatExact, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

interface FundingBarProps {
  totals: Pick<Totals, 'pledged' | 'delivered' | 'merged' | 'in_flight'>;
  goal: number;
  /** `lg` is the project page bar, with a breakdown on hover and focus; `sm` sits in cards. */
  size?: 'sm' | 'lg';
  className?: string;
}

const share = (part: number, whole: number) => `${Math.min(100, Math.max(0, (part / whole) * 100))}%`;

function describe(totals: FundingBarProps['totals'], goal: number): string {
  return (
    `${formatCompact(totals.delivered)} delivered of a ${formatCompact(goal)} token goal ` +
    `(${formatPercent(totals.delivered, goal)}); ${formatCompact(totals.pledged)} pledged, ` +
    `${formatCompact(totals.merged)} merged`
  );
}

/**
 * Stacked progress toward the token goal. The track is the goal; the pale fill is what has
 * been pledged; on top of it, merged tokens are solid, delivered-but-unmerged tokens are in
 * the accent, and running work is a lighter accent tail.
 */
function Bar({ totals, goal, size }: Required<Pick<FundingBarProps, 'totals' | 'goal' | 'size'>>) {
  const whole = Math.max(goal, 1);
  const segment = 'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out';
  return (
    <span className={cn('relative block overflow-hidden rounded-full bg-muted', size === 'lg' ? 'h-2.5' : 'h-1.5')}>
      <span className={cn(segment, 'bg-foreground/15')} style={{ width: share(totals.pledged, whole) }} />
      <span className={cn(segment, 'bg-live/40')} style={{ width: share(totals.delivered + totals.in_flight, whole) }} />
      <span className={cn(segment, 'bg-live')} style={{ width: share(totals.delivered, whole) }} />
      <span className={cn(segment, 'bg-foreground')} style={{ width: share(totals.merged, whole) }} />
    </span>
  );
}

export function FundingBar({ totals, goal, size = 'sm', className }: FundingBarProps) {
  if (size === 'sm') {
    return (
      <div role="img" aria-label={describe(totals, goal)} className={className}>
        <Bar totals={totals} goal={goal} size="sm" />
      </div>
    );
  }
  const rows = [
    ['Merged', totals.merged, 'bg-foreground'],
    ['Delivered', totals.delivered, 'bg-live'],
    ['Running now', totals.in_flight, 'bg-live/40'],
    ['Pledged', totals.pledged, 'bg-foreground/15'],
  ] as const;
  return (
    <TooltipProvider delayDuration={150}>
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users can read the same breakdown the pointer gets. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div role="img" aria-label={describe(totals, goal)} tabIndex={0} className={cn('rounded-full py-1', className)}>
          <Bar totals={totals} goal={goal} size="lg" />
        </div>
      </TooltipTrigger>
      <TooltipContent className="grid gap-1.5 p-3">
        {rows.map(([label, value, swatch]) => (
          <span key={label} className="flex items-center gap-2 text-xs">
            <span className={cn('size-2 rounded-full ring-1 ring-background/30', swatch)} aria-hidden="true" />
            <span className="mr-4 flex-1">{label}</span>
            <span className="num">{formatExact(value)}</span>
          </span>
        ))}
        <span className="mt-1 flex items-center gap-2 border-t border-background/20 pt-1.5 text-xs">
          <span className="mr-4 flex-1 pl-4">Goal</span>
          <span className="num">{formatExact(goal)}</span>
        </span>
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  );
}
