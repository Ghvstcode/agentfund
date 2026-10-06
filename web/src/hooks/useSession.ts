import { useSyncExternalStore } from 'react';
import { session } from '../lib/session';

/** The current session token, or null when signed out. */
export function useSession(): string | null {
  return useSyncExternalStore(session.subscribe, session.getToken, () => null);
}
