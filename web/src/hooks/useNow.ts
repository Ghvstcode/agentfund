import { useSyncExternalStore } from 'react';

// One shared minute clock, so every relative time on the page updates together.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    listeners.forEach((notify) => notify());
  }, 30_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time, refreshed every 30 seconds. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
