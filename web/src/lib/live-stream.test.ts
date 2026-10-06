import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamTotals } from '../api/types';
import { backoffDelay, type LiveStatus, startLiveStream } from './live-stream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    const event = { data: data === undefined ? undefined : JSON.stringify(data) } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

const frame = (delivered: number): StreamTotals => ({
  scope: 'instance',
  totals: { pledged: 0, reported: 0, delivered, merged: 0, in_flight: 0 },
});

function start(overrides: Partial<Parameters<typeof startLiveStream>[0]> = {}) {
  const totals: number[] = [];
  const statuses: LiveStatus[] = [];
  const events: string[] = [];
  const poll = vi.fn(async () => frame(777));
  const stop = startLiveStream({
    url: 'http://api.test/v1/stream',
    poll,
    onTotals: (next) => totals.push(next.totals.delivered),
    onEvent: (event) => events.push(event.action),
    onStatus: (status) => statuses.push(status),
    EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    failuresBeforePolling: 2,
    pollIntervalMs: 5000,
    idleTimeoutMs: 45_000,
    ...overrides,
  });
  return { totals, statuses, events, poll, stop };
}

const latest = () => FakeEventSource.instances.at(-1) as FakeEventSource;

describe('backoffDelay', () => {
  it('doubles per failure up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 1000, 8000))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

describe('startLiveStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('delivers totals and audit events while the stream is open', () => {
    const live = start();
    expect(live.statuses).toEqual(['connecting']);
    latest().emit('open');
    latest().emit('totals', frame(10));
    latest().emit('event', { id: 'evt_1', at: '2026-10-06T00:00:00Z', action: 'task.claimed' });
    latest().emit('totals', frame(25));
    expect(live.statuses).toEqual(['connecting', 'live']);
    expect(live.totals).toEqual([10, 25]);
    expect(live.events).toEqual(['task.claimed']);
    expect(live.poll).not.toHaveBeenCalled();
    live.stop();
  });

  it('ignores a frame that is not valid JSON', () => {
    const live = start();
    latest().emit('open');
    latest().emit('totals');
    expect(live.totals).toEqual([]);
    live.stop();
  });

  it('reconnects with exponential backoff', () => {
    const live = start({ failuresBeforePolling: 99 });
    latest().emit('error');
    expect(latest().closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    latest().emit('error');
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    latest().emit('error');
    vi.advanceTimersByTime(4000);
    expect(FakeEventSource.instances).toHaveLength(4);
    live.stop();
  });

  it('resets the backoff after a successful connection', () => {
    const live = start({ failuresBeforePolling: 99 });
    latest().emit('error');
    vi.advanceTimersByTime(1000);
    latest().emit('error');
    vi.advanceTimersByTime(2000);
    latest().emit('open');
    latest().emit('error');
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);
    live.stop();
  });

  it('falls back to polling after repeated failures, and keeps trying SSE', async () => {
    const live = start();
    latest().emit('error');
    expect(live.poll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    latest().emit('error');

    expect(live.poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.totals).toEqual([777]);
    expect(live.statuses.at(-1)).toBe('polling');

    await vi.advanceTimersByTimeAsync(5000);
    expect(live.poll).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(3);
    live.stop();
  });

  it('stops polling as soon as SSE comes back', async () => {
    const live = start();
    latest().emit('error');
    vi.advanceTimersByTime(1000);
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(2000);

    latest().emit('open');
    latest().emit('totals', frame(900));
    const polls = live.poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(live.poll).toHaveBeenCalledTimes(polls);
    expect(live.statuses.at(-1)).toBe('live');
    expect(live.totals.at(-1)).toBe(900);
    live.stop();
  });

  it('reports offline when polling fails too', async () => {
    const live = start({ poll: vi.fn(async () => Promise.reject(new Error('down'))) });
    latest().emit('error');
    vi.advanceTimersByTime(1000);
    latest().emit('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(live.statuses.at(-1)).toBe('offline');
    live.stop();
  });

  it('treats a silent connection as dead and reconnects', () => {
    const live = start({ failuresBeforePolling: 99 });
    latest().emit('open');
    vi.advanceTimersByTime(30_000);
    latest().emit('ping');
    vi.advanceTimersByTime(44_999);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(latest().closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    live.stop();
  });

  it('polls only when the instance does not offer SSE', async () => {
    const live = start({ sse: false });
    expect(FakeEventSource.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(live.totals).toEqual([777]);
    expect(live.statuses).toEqual(['polling']);
    live.stop();
  });

  it('goes quiet after stop', async () => {
    const live = start();
    latest().emit('error');
    live.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(live.poll).not.toHaveBeenCalled();
    expect(live.statuses).toEqual(['connecting']);
  });
});
