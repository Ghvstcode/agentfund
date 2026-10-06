import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface StatProps {
  label: string;
  value: ReactNode;
  /** Small print under the value. */
  note?: ReactNode;
  /** Tailwind background class for a colour key matching the funding bar. */
  swatch?: string;
  className?: string;
}

/** One labelled figure. */
export function Stat({ label, value, note, swatch, className }: StatProps) {
  return (
    <div className={cn('grid min-w-0 gap-1', className)}>
      <dt className="label flex items-center gap-1.5">
        {swatch && <span className={cn('size-2 rounded-full', swatch)} aria-hidden="true" />}
        {label}
      </dt>
      <dd className="num text-xl leading-none font-medium tracking-tight">{value}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}
