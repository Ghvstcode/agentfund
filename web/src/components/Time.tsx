import { useNow } from '../hooks/useNow';
import { absoluteTime, relativeTime } from '../lib/format';

/** Relative time ("3h ago") with the exact UTC timestamp in the tooltip. */
export function Time({ value }: { value: string }) {
  const now = useNow();
  return (
    <time className="time" dateTime={value} title={absoluteTime(value)}>
      {relativeTime(value, now)}
    </time>
  );
}
