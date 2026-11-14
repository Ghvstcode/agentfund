/**
 * `SHA256:<hex>` of an instance or project key in minisign encoding: the digest of the decoded
 * key bytes, as the server computes `pubkey_fingerprint`. Resolves to null where it cannot be
 * computed (a malformed key, or a page served without a secure context, which has no
 * `crypto.subtle`); callers then show the key itself.
 */
export async function keyFingerprint(encoded: string): Promise<string | null> {
  try {
    const binary = atob(encoded.trim());
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `SHA256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}
