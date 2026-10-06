import type { LiveStatus } from '../lib/live-stream';

const LABELS: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  polling: 'Updating every few seconds',
  offline: 'Offline, retrying',
};

/** Connection state of the live stream: an accent dot while live, plain text otherwise. */
export function LiveIndicator({ status }: { status: LiveStatus }) {
  return (
    <span className="live-indicator" data-status={status}>
      <span className="live-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}
