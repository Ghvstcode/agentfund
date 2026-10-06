/** Test-only minisign *signer* (the server itself only verifies). Ed25519 + BLAKE2b-512 via node:crypto. */
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { generateKeyPair, PKCS8_PREFIX, rotationStatement, type KeyPair, type Rotation } from "../../src/lib/minisign.js";

export { generateKeyPair, type KeyPair };

export function sign(message: Uint8Array, pair: Pick<KeyPair, "keyId" | "secretSeed">, opts: { trustedComment?: string; untrustedComment?: string; legacy?: boolean } = {}): string {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, pair.secretSeed]), format: "der", type: "pkcs8" });
  const trusted = opts.trustedComment ?? `agentfund lock v1 key:${pair.keyId.toString("hex")}`;
  const signature = opts.legacy ? edSign(null, Buffer.from(message), key) : edSign(null, createHash("blake2b512").update(message).digest(), key);
  const global = edSign(null, Buffer.concat([signature, Buffer.from(trusted, "utf8")]), key);
  const sigLine = Buffer.concat([Buffer.from(opts.legacy ? "Ed" : "ED"), pair.keyId, signature]).toString("base64");
  return `untrusted comment: ${opts.untrustedComment ?? "signature from agentfund"}\n${sigLine}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

export function signRotation(from: KeyPair, to: KeyPair): Rotation {
  return { from: from.publicKey, to: to.publicKey, signature: sign(rotationStatement(from.publicKey, to.publicKey), from, { trustedComment: "agentfund rotation v1" }) };
}
