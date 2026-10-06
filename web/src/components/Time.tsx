import { useNow } from '@/hooks/useNow';
import { absoluteTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Relative time ("3h ago") with the exact UTC timestamp in the tooltip. */
export function Time({ value, className }: { value: string; className?: string }) {
  const now = useNow();
  return (
    <time className={cn('whitespace-nowrap tabular-nums', className)} dateTime={value} title={absoluteTime(value)}>
      {relativeTime(value, now)}
    </time>
  );
}
