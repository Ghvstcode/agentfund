import { createHmac, timingSafeEqual } from "node:crypto";
import type { Evidence } from "../services/ci.js";

/** What an adapter extracts from one webhook delivery. */
export interface Delivery {
  /** Lower-cased canonical repo URL the delivery is about, or null when it carries none (e.g. ping). */
  repoKey: string | null;
  evidence: Evidence[];
  /** Set by a push: the full ref that moved, so the indexer can re-pin. */
  pushedRef?: string;
}

export class PayloadError extends Error {}

/**
 * A CI provider integration: recognises its deliveries by header, names the header that
 * carries the HMAC, and turns an authenticated payload into provider-neutral evidence.
 */
export interface CiAdapter {
  readonly name: "github" | "generic";
  readonly signatureHeader: string;
  accepts(headers: Headers): boolean;
  /**
   * Which repository an UNVERIFIED payload claims to be about — used only to pick the secret
   * its signature must verify under. Never throws; null when the payload names none.
   */
  claimedRepo(payload: unknown): string | null;
  parse(headers: Headers, payload: unknown): Delivery;
}

/** `sha256=<hex>` HMAC-SHA256 over the raw request bytes, compared in constant time. */
export function verifySignature(secret: string, rawBody: Uint8Array, header: string | null | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice(7).trim(), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const signBody = (secret: string, rawBody: string | Uint8Array): string => `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
