import { createHash, randomBytes, randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomId(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export type IdPrefix = "clm" | "rep" | "plg" | "key" | "evt";
export const newId = (prefix: IdPrefix): string => `${prefix}_${randomId(20)}`;

/** First 8 characters after `clm_`; the suffix of the branch a worker must push. */
export const claimShort = (claimId: string): string => claimId.slice(4, 12);

export const newSessionToken = (): string => `afs_${randomBytes(32).toString("base64url")}`;
export const newApiKey = (): string => `af_${randomBytes(32).toString("base64url")}`;
export const newSecret = (): string => randomBytes(32).toString("hex");

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return s || "project";
}
