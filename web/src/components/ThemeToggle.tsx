import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { theme } from '@/lib/theme';
import { Button } from './Button';

/** Switches between the light and dark palettes and remembers the choice on this device. */
export function ThemeToggle() {
  const current = useTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  const Icon = current === 'dark' ? Sun : Moon;
  return (
    <Button variant="quiet" className="size-8 px-0" onClick={() => theme.set(next)} aria-label={`Switch to ${next} theme`}>
      <Icon strokeWidth={1.5} aria-hidden="true" />
    </Button>
  );
}
