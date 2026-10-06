import { useSyncExternalStore } from 'react';
import { type Theme, theme } from '../lib/theme';

export function useTheme(): Theme {
  return useSyncExternalStore(theme.subscribe, theme.get, () => 'light');
}
