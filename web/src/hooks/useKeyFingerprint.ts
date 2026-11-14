import { useEffect, useState } from 'react';
import { keyFingerprint } from '@/lib/fingerprint';

/** Fingerprint of a key, computed in the browser. `undefined` while working, null when it cannot be. */
export function useKeyFingerprint(encoded: string | null | undefined): string | null | undefined {
  const [result, setResult] = useState<{ key: string; fingerprint: string | null }>();
  useEffect(() => {
    if (!encoded) return;
    let current = true;
    void keyFingerprint(encoded).then((fingerprint) => {
      if (current) setResult({ key: encoded, fingerprint });
    });
    return () => {
      current = false;
    };
  }, [encoded]);
  if (!encoded) return null;
  return result?.key === encoded ? result.fingerprint : undefined;
}
