/** Theme preference: follow the system unless the visitor picked one; the pick is persisted. */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'agentfund.theme';
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function system(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** shadcn themes hang off a `dark` class on <html>. */
function apply(next: Theme) {
  document.documentElement.classList.toggle('dark', next === 'dark');
}

function notify() {
  apply(theme.get());
  listeners.forEach((listener) => listener());
}

export const theme = {
  /** The theme currently on screen. */
  get: (): Theme => stored() ?? system(),
  set(next: Theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted; still applied for this page.
    }
    notify();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', notify);
    return () => {
      listeners.delete(listener);
      media?.removeEventListener('change', notify);
    };
  },
};
