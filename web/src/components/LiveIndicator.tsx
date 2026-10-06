import type { LiveStatus } from '@/lib/live-stream';
import { cn } from '@/lib/utils';

const LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  polling: 'Updating every few seconds',
  offline: 'Offline, retrying',
};

/** Connection state of the live stream: a pulsing accent dot while live, a hollow one otherwise. */
export function LiveIndicator({ status, className }: { status: LiveStatus; className?: string }) {
  const live = status === 'live';
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-6 items-center gap-2 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap',
        live ? 'border-live/25 bg-live/8 text-live' : 'text-muted-foreground',
        className,
      )}
    >
      {live ? <span className="live-dot" aria-hidden="true" /> : <span className="size-2 rounded-full border border-current" aria-hidden="true" />}
      {LABELS[status]}
    </span>
  );
}
