import { useCallback, useSyncExternalStore } from 'react';

/** Whether a CSS media query currently matches. False where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia?.(query);
      media?.addEventListener('change', onChange);
      return () => media?.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
