import { formatCompact, formatExact } from '@/lib/format';
import { cn } from '@/lib/utils';

interface NumProps {
  value: number;
  /** Show every digit instead of the compact form. */
  exact?: boolean;
  /** Unit for the tooltip; pass an empty string for bare counts. */
  unit?: string;
  className?: string;
}

/** A token count in the mono face: compact on screen, exact in the tooltip. */
export function Num({ value, exact = false, unit = 'tokens', className }: NumProps) {
  const full = formatExact(value);
  return (
    <span className={cn('num whitespace-nowrap', className)} title={unit ? `${full} ${unit}` : full}>
      {exact ? full : formatCompact(value)}
    </span>
  );
}
