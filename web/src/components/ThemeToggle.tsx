import { useTheme } from '../hooks/useTheme';
import { theme } from '../lib/theme';

/** Switches between the light and dark palettes and remembers the choice on this device. */
export function ThemeToggle() {
  const current = useTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="theme-toggle" onClick={() => theme.set(next)} aria-label={`Switch to ${next} theme`}>
      <span className="theme-toggle__glyph" aria-hidden="true" />
      <span aria-hidden="true">{next === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  );
}
