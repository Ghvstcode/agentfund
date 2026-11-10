import { cn } from '@/lib/utils';

/**
 * One bar per day, oldest first. Days with delivery are green; empty days keep a hairline
 * stub so the calendar still reads. Stretches to its box.
 */
export function DailyBars({ values, label, className }: { values: readonly number[]; label: string; className?: string }) {
  const max = Math.max(...values, 0);
  const width = 100;
  const height = 40;
  const gap = values.length > 1 ? 0.9 : 0;
  const bar = values.length > 0 ? (width - gap * (values.length - 1)) / values.length : 0;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} className={cn('block w-full', className)}>
      {values.map((value, index) => {
        const h = max > 0 && value > 0 ? Math.max(1.5, (value / max) * height) : 0.8;
        return (
          <rect
            key={index}
            x={index * (bar + gap)}
            y={height - h}
            width={bar}
            height={h}
            className={value > 0 ? 'fill-pass' : 'fill-border'}
          />
        );
      })}
    </svg>
  );
}
