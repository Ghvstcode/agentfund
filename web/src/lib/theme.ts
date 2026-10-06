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

export const theme = {
  /** The theme currently on screen. */
  get: (): Theme => stored() ?? system(),
  set(next: Theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted; still applied for this page.
    }
    document.documentElement.dataset.theme = next;
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', listener);
    return () => {
      listeners.delete(listener);
      media?.removeEventListener('change', listener);
    };
  },
};
