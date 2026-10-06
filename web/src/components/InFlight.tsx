import { cn } from '@/lib/utils';
import { TokenCounter } from './TokenCounter';

interface InFlightProps {
  /** Tokens of currently running claims; undefined while loading. */
  tokens: number | undefined;
  className?: string;
}

/**
 * The "running now" line under a counter. It always occupies its row, so a run starting or
 * finishing moves nothing; the amount streams in the accent colour while work is in flight.
 */
export function InFlight({ tokens, className }: InFlightProps) {
  const running = tokens !== undefined && tokens > 0;
  return (
    <p className={cn('flex h-7 items-center gap-2 text-sm', className)}>
      {running ? (
        <span className="inline-flex h-7 items-center gap-2 rounded-full border border-live/25 bg-live/8 pr-3 pl-2.5 font-medium text-live">
          <span className="live-dot" aria-hidden="true" />
          <span>Running now</span>
          <TokenCounter value={tokens} label="tokens in flight" size="sm" tone="accent" />
        </span>
      ) : (
        <span className="text-muted-foreground">{tokens === undefined ? ' ' : 'No worker is running right now.'}</span>
      )}
    </p>
  );
}
