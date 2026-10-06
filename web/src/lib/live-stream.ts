import type { AuditEvent, StreamTotals } from '../api/types';

/**
 * `connecting` first attempt in progress · `live` SSE is open · `polling` SSE is failing and
 * totals come from periodic requests · `offline` neither works right now.
 */
export type LiveStatus = 'connecting' | 'live' | 'polling' | 'offline';

export interface LiveStreamOptions {
  /** Absolute URL of `GET /v1/stream`. */
  url: string;
  /** Fallback source of the same frame, used while SSE is unavailable. */
  poll: () => Promise<StreamTotals>;
  onTotals: (frame: StreamTotals) => void;
  onEvent?: (event: AuditEvent) => void;
  onStatus?: (status: LiveStatus) => void;
  /** Set false when the instance does not advertise SSE: poll only. */
  sse?: boolean;
  EventSourceImpl?: typeof EventSource;
  /** First reconnect delay; doubles per consecutive failure up to `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Consecutive SSE failures before polling starts alongside the reconnect attempts. */
  failuresBeforePolling?: number;
  pollIntervalMs?: number;
  /** The server pings every 15 s; silence longer than this means the connection is dead. */
  idleTimeoutMs?: number;
}

/** Delay before reconnect attempt number `failures` (1-based). */
export function backoffDelay(failures: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failures - 1));
}

function parse<T>(message: Event): T | null {
  try {
    return JSON.parse((message as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/**
 * Subscribe to live totals and audit events. Reconnects with exponential backoff, and falls
 * back to polling when SSE keeps failing. There is no replay: after a reconnect the first
 * `totals` frame is authoritative. Returns a function that stops everything.
 */
export function startLiveStream(options: LiveStreamOptions): () => void {
  const {
    url,
    poll,
    onTotals,
    onEvent,
    onStatus,
    sse = true,
    EventSourceImpl = globalThis.EventSource,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    failuresBeforePolling = 2,
    pollIntervalMs = 5000,
    idleTimeoutMs = 45_000,
  } = options;

  let stopped = false;
  let source: EventSource | null = null;
  let failures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let status: LiveStatus | null = null;

  const setStatus = (next: LiveStatus) => {
    if (stopped || next === status) return;
    status = next;
    onStatus?.(next);
  };

  const pollOnce = async () => {
    try {
      const frame = await poll();
      if (stopped || pollTimer === undefined) return;
      onTotals(frame);
      setStatus('polling');
    } catch {
      if (pollTimer !== undefined) setStatus('offline');
    }
  };

  const startPolling = () => {
    if (pollTimer !== undefined) return;
    pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);
    void pollOnce();
  };

  const stopPolling = () => {
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const fail = () => {
    if (stopped) return;
    clearTimeout(idleTimer);
    source?.close();
    source = null;
    failures += 1;
    if (failures >= failuresBeforePolling) startPolling();
    else setStatus('connecting');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoffDelay(failures, baseDelayMs, maxDelayMs));
  };

  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(fail, idleTimeoutMs);
  };

  function connect() {
    if (stopped) return;
    const next = new EventSourceImpl(url);
    source = next;
    next.addEventListener('open', () => {
      failures = 0;
      stopPolling();
      setStatus('live');
      armIdleTimer();
    });
    next.addEventListener('totals', (message) => {
      armIdleTimer();
      const frame = parse<StreamTotals>(message);
      if (frame) onTotals(frame);
    });
    next.addEventListener('event', (message) => {
      armIdleTimer();
      const event = parse<AuditEvent>(message);
      if (event) onEvent?.(event);
    });
    next.addEventListener('ping', armIdleTimer);
    next.addEventListener('error', fail);
  }

  if (sse && typeof EventSourceImpl === 'function') {
    setStatus('connecting');
    connect();
  } else {
    startPolling();
  }

  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(idleTimer);
    stopPolling();
    source?.close();
    source = null;
  };
}
