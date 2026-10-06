import { useId } from 'react';
import { cn } from '@/lib/utils';

interface SparklineProps {
  /** One value per bucket, oldest first. */
  values: readonly number[];
  /** Text alternative, e.g. "Tokens delivered per day, last 30 days: 4.2M in total". */
  label: string;
  className?: string;
  /** Draw the soft area under the line. */
  area?: boolean;
}

const WIDTH = 100;
const HEIGHT = 32;
const PAD = 2;

/** Points for a series scaled into the viewBox; a flat series sits on the baseline. */
export function sparklinePoints(values: readonly number[]): [number, number][] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? WIDTH / (values.length - 1) : 0;
  return values.map((value, index) => [
    values.length > 1 ? index * step : WIDTH / 2,
    max === 0 ? HEIGHT - PAD : HEIGHT - PAD - (Math.max(0, value) / max) * (HEIGHT - 2 * PAD),
  ]);
}

/**
 * A compact line/area chart. Stretches to its box; the stroke keeps a constant width. The
 * newest point is marked in the accent colour: it is the one that is still moving.
 */
export function Sparkline({ values, label, className, area = true }: SparklineProps) {
  const gradient = useId();
  const points = sparklinePoints(values);
  const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const last = points.at(-1);
  const flat = values.every((value) => value === 0);

  return (
    <div role="img" aria-label={label} className={cn('relative h-8 w-full', className)}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="size-full overflow-visible" aria-hidden="true">
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && !flat && points.length > 1 && <path d={`${line} L${WIDTH} ${HEIGHT} L0 ${HEIGHT} Z`} fill={`url(#${gradient})`} />}
        {points.length > 1 && (
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeOpacity={flat ? 0.25 : 0.9}
            strokeWidth="1.25"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={flat ? '2 3' : undefined}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {last && !flat && (
        <span
          aria-hidden="true"
          className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-live ring-2 ring-card"
          style={{ left: `${last[0]}%`, top: `${(last[1] / HEIGHT) * 100}%` }}
        />
      )}
    </div>
  );
}
