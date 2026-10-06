/** Browser session: an `afs_` bearer token kept in localStorage, observable by React. */
const STORAGE_KEY = 'agentfund.session';
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let token: string | null = read();

function emit() {
  listeners.forEach((listener) => listener());
}

export const session = {
  getToken: (): string | null => token,
  setToken(next: string) {
    token = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage is unavailable (private mode): the session lasts until the tab closes.
    }
    emit();
  },
  clear() {
    if (token === null) return;
    token = null;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to remove.
    }
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    token = event.newValue;
    emit();
  });
}

/** Read `#token=afs_…` out of a URL fragment, as left by the OAuth redirect. */
export function tokenFromFragment(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return value && value.startsWith('afs_') ? value : null;
}
