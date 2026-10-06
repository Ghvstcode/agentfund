/**
 * Minisign verification (prehashed variant only), pure and dependency-free.
 *
 * Public key:  base64( "Ed" || key_id[8] || ed25519_pk[32] )                       (42 bytes)
 * Signature file (4 lines):
 *   untrusted comment: <free text>
 *   base64( alg[2] || key_id[8] || sig[64] )        alg "ED" = prehashed, "Ed" = legacy
 *   trusted comment: <text>
 *   base64( global_sig[64] )                        Ed25519 over sig[64] || trusted comment bytes
 * Prehashed: sig = Ed25519( BLAKE2b-512(message) ).
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify as edVerify, type KeyObject } from "node:crypto";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const UNTRUSTED_PREFIX = "untrusted comment: ";
const TRUSTED_PREFIX = "trusted comment: ";
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class MinisignError extends Error {}

export interface PublicKey {
  /** The canonical base64 encoding. */
  encoded: string;
  keyId: Buffer;
  key: Buffer;
}

export interface ParsedSignature {
  algorithm: "ED" | "Ed";
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

function b64(text: string, what: string): Buffer {
  if (!B64.test(text) || text.length % 4 !== 0) throw new MinisignError(`${what} is not valid base64`);
  const buf = Buffer.from(text, "base64");
  if (buf.toString("base64") !== text) throw new MinisignError(`${what} is not canonical base64`);
  return buf;
}

export function parsePublicKey(encoded: string): PublicKey {
  const raw = b64(encoded.trim(), "public key");
  if (raw.length !== 42) throw new MinisignError("public key must decode to 42 bytes");
  if (raw.subarray(0, 2).toString("latin1") !== "Ed") throw new MinisignError("public key algorithm is not Ed25519");
  return { encoded: encoded.trim(), keyId: Buffer.from(raw.subarray(2, 10)), key: Buffer.from(raw.subarray(10)) };
}

export const encodePublicKey = (keyId: Uint8Array, key: Uint8Array): string => Buffer.concat([Buffer.from("Ed"), keyId, key]).toString("base64");

/** `SHA256:<hex>` over the 42 decoded bytes of the encoded key (manifest spec §2). */
export function fingerprint(encoded: string): string {
  parsePublicKey(encoded);
  return `SHA256:${createHash("sha256").update(Buffer.from(encoded.trim(), "base64")).digest("hex")}`;
}

export function parseSignature(text: string): ParsedSignature {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 4) throw new MinisignError("signature must have exactly 4 lines");
  const [untrusted, sigLine, trusted, globalLine] = lines as [string, string, string, string];
  if (!untrusted.startsWith(UNTRUSTED_PREFIX)) throw new MinisignError("missing untrusted comment line");
  if (!trusted.startsWith(TRUSTED_PREFIX)) throw new MinisignError("missing trusted comment line");
  const sig = b64(sigLine, "signature");
  if (sig.length !== 74) throw new MinisignError("signature must decode to 74 bytes");
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED" && algorithm !== "Ed") throw new MinisignError("unknown signature algorithm");
  const globalSignature = b64(globalLine, "global signature");
  if (globalSignature.length !== 64) throw new MinisignError("global signature must decode to 64 bytes");
  return {
    algorithm,
    keyId: Buffer.from(sig.subarray(2, 10)),
    signature: Buffer.from(sig.subarray(10)),
    trustedComment: trusted.slice(TRUSTED_PREFIX.length),
    globalSignature,
  };
}

const toKeyObject = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });

/**
 * Verifies a detached minisign signature. Throws MinisignError describing the first failed
 * check: legacy algorithm, key id mismatch, file signature, global signature.
 */
export function verify(message: Uint8Array, signatureText: string, publicKey: string | PublicKey): ParsedSignature {
  const pk = typeof publicKey === "string" ? parsePublicKey(publicKey) : publicKey;
  const sig = parseSignature(signatureText);
  if (sig.algorithm !== "ED") throw new MinisignError("legacy non-prehashed signature (Ed) is not accepted");
  if (!sig.keyId.equals(pk.keyId)) throw new MinisignError("signature key id does not match the public key");
  const key = toKeyObject(pk.key);
  const digest = createHash("blake2b512").update(message).digest();
  if (!edVerify(null, digest, key, sig.signature)) throw new MinisignError("signature verification failed");
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!edVerify(null, global, key, sig.globalSignature)) throw new MinisignError("trusted comment (global) signature verification failed");
  return sig;
}

export function isValid(message: Uint8Array, signatureText: string, publicKey: string): boolean {
  try {
    verify(message, signatureText, publicKey);
    return true;
  } catch {
    return false;
  }
}

export const rotationStatement = (from: string, to: string): Buffer => Buffer.from(`agentfund-key-rotation-v1\nfrom: ${from}\nto: ${to}\n`, "utf8");

export interface Rotation {
  from: string;
  to: string;
  signature: string;
}

export const MAX_ROTATIONS = 16;

/**
 * Follows the rotation chain from the pinned key (manifest spec §3): walks `rotations` in
 * order, taking each link whose `from` is the current key. A link from the current key with
 * an invalid signature rejects the whole lock. Returns the key the lock must be signed with.
 */
export function resolveRotations(pinned: string, rotations: readonly Rotation[]): { key: string; hops: number } {
  parsePublicKey(pinned);
  if (rotations.length > MAX_ROTATIONS) throw new MinisignError(`more than ${MAX_ROTATIONS} rotations`);
  let current = pinned;
  let hops = 0;
  for (const link of rotations) {
    if (link.from !== current) continue;
    parsePublicKey(link.to);
    if (link.to === link.from) throw new MinisignError("rotation link rotates a key to itself");
    try {
      verify(rotationStatement(link.from, link.to), link.signature, link.from);
    } catch (err) {
      throw new MinisignError(`rotation ${hops + 1} is not validly signed by its "from" key: ${(err as Error).message}`);
    }
    current = link.to;
    hops++;
  }
  return { key: current, hops };
}

/** Verifies `message` against the pinned key, following rotations. Returns the signing key. */
export function verifyWithRotations(message: Uint8Array, signatureText: string, pinned: string, rotations: readonly Rotation[]): { key: string; hops: number } {
  const resolved = resolveRotations(pinned, rotations);
  verify(message, signatureText, resolved.key);
  return resolved;
}

/* ---- key generation: the instance identity (signing lives in the test helpers only) ---- */

export interface KeyPair {
  publicKey: string;
  keyId: Buffer;
  /** Raw 32-byte Ed25519 seed. */
  secretSeed: Buffer;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(SPKI_PREFIX.length);
  const seed = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(PKCS8_PREFIX.length);
  const keyId = randomBytes(8);
  return { publicKey: encodePublicKey(keyId, pub), keyId, secretSeed: Buffer.from(seed) };
}
