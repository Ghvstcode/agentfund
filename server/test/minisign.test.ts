import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprint, isValid, MinisignError, parsePublicKey, parseSignature, resolveRotations, rotationStatement, verify, verifyWithRotations } from "../src/lib/minisign.js";
import { generateKeyPair, sign, signRotation } from "./helpers/minisign.js";

const fx = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/minisign", name));
const hasMinisign = spawnSync("minisign", ["-v"]).status === 0;

describe("minisign: vectors produced by the real minisign 0.12 CLI", () => {
  const pubkey = fx("pubkey.txt").toString("utf8").trim();
  const msg = fx("msg.txt");
  const sig = fx("msg.txt.minisig").toString("utf8");

  it("accepts a prehashed (ED) signature", () => {
    const parsed = verify(msg, sig, pubkey);
    expect(parsed.algorithm).toBe("ED");
    expect(parsed.trustedComment).toBe("agentfund lock v1 key:test");
  });

  it("rejects the legacy non-prehashed (Ed) variant", () => {
    const legacy = fx("legacy.minisig").toString("utf8");
    expect(parseSignature(legacy).algorithm).toBe("Ed");
    expect(() => verify(msg, legacy, pubkey)).toThrow(/legacy/);
  });

  it("rejects a modified message", () => {
    expect(isValid(Buffer.concat([msg, Buffer.from("x")]), sig, pubkey)).toBe(false);
  });

  it("rejects a modified trusted comment (global signature)", () => {
    const tampered = sig.replace("key:test", "key:evil");
    expect(() => verify(msg, tampered, pubkey)).toThrow(/global/);
  });

  it("ignores the untrusted comment and tolerates CRLF", () => {
    expect(isValid(msg, sig.replace(/^untrusted comment: .*/, "untrusted comment: whatever"), pubkey)).toBe(true);
    expect(isValid(msg, sig.replace(/\n/g, "\r\n"), pubkey)).toBe(true);
  });

  it("rejects a signature from a different key and a key-id mismatch", () => {
    const other = generateKeyPair();
    expect(() => verify(msg, sig, other.publicKey)).toThrow(/key id/);
    // Same key id, different key material.
    const raw = Buffer.from(pubkey, "base64");
    const forged = Buffer.concat([raw.subarray(0, 10), Buffer.from(other.publicKey, "base64").subarray(10)]).toString("base64");
    expect(() => verify(msg, sig, forged)).toThrow(/signature verification failed/);
  });

  it("rejects malformed signatures", () => {
    const lines = sig.trimEnd().split("\n");
    expect(() => parseSignature(lines.slice(0, 3).join("\n"))).toThrow(MinisignError);
    expect(() => parseSignature([lines[0], "AAAA", lines[2], lines[3]].join("\n"))).toThrow(/74 bytes/);
    expect(() => parseSignature([lines[0], lines[1], "trusted: x", lines[3]].join("\n"))).toThrow(/trusted comment/);
    expect(() => parseSignature([lines[0], "not base64!!", lines[2], lines[3]].join("\n"))).toThrow(/base64/);
    expect(() => parseSignature([lines[0], lines[1], lines[2], "AAAA"].join("\n"))).toThrow(/64 bytes/);
  });
});

describe("minisign: keys and fingerprints", () => {
  it("parses the 42-byte public key and rejects others", () => {
    const pair = generateKeyPair();
    const pk = parsePublicKey(pair.publicKey);
    expect(pk.keyId.equals(pair.keyId)).toBe(true);
    expect(pair.publicKey).toMatch(/^[A-Za-z0-9+/]{56}$/);
    expect(() => parsePublicKey("AAAA")).toThrow(/42 bytes/);
    expect(() => parsePublicKey(Buffer.concat([Buffer.from("XX"), Buffer.alloc(40)]).toString("base64"))).toThrow(/Ed25519/);
  });

  it("fingerprint is SHA256 over the decoded key bytes", () => {
    // The example key from spec/manifest.md.
    expect(fingerprint("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")).toMatch(/^SHA256:[0-9a-f]{64}$/);
    expect(fingerprint("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")).not.toBe(fingerprint(generateKeyPair().publicKey));
  });

  it("round-trips with the test signer", () => {
    const pair = generateKeyPair();
    const msg = Buffer.from("lock bytes");
    expect(isValid(msg, sign(msg, pair), pair.publicKey)).toBe(true);
    expect(() => verify(msg, sign(msg, pair, { legacy: true }), pair.publicKey)).toThrow(/legacy/);
  });

  it.skipIf(!hasMinisign)("the test signer's output verifies with the stock minisign tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-ms-"));
    const pair = generateKeyPair();
    const msg = Buffer.from('{"lock_version":1}\n');
    writeFileSync(join(dir, "m"), msg);
    writeFileSync(join(dir, "m.minisig"), sign(msg, pair));
    const out = execFileSync("minisign", ["-Vm", join(dir, "m"), "-P", pair.publicKey], { encoding: "utf8" });
    expect(out).toContain("Signature and comment signature verified");
  });

  it.skipIf(!hasMinisign)("verifies a signature freshly made by the stock minisign tool", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-ms-"));
    writeFileSync(join(dir, "m"), "fresh\n");
    execFileSync("minisign", ["-G", "-W", "-f", "-p", join(dir, "k.pub"), "-s", join(dir, "k.key")]);
    execFileSync("minisign", ["-S", "-s", join(dir, "k.key"), "-m", join(dir, "m"), "-t", "hello"]);
    const pub = readFileSync(join(dir, "k.pub"), "utf8").split("\n")[1]!;
    expect(verify(readFileSync(join(dir, "m")), readFileSync(join(dir, "m.minisig"), "utf8"), pub).trustedComment).toBe("hello");
  });
});

describe("minisign: rotation chain", () => {
  const k0 = generateKeyPair();
  const k1 = generateKeyPair();
  const k2 = generateKeyPair();
  const msg = Buffer.from("lock");

  it("statement has the exact three-line form", () => {
    expect(rotationStatement("A", "B").toString()).toBe("agentfund-key-rotation-v1\nfrom: A\nto: B\n");
  });

  it("n = 0: the pinned key signs directly", () => {
    expect(verifyWithRotations(msg, sign(msg, k0), k0.publicKey, [])).toEqual({ key: k0.publicKey, hops: 0 });
  });

  it("follows K0 → K1 → K2 and only then accepts K2", () => {
    const chain = [signRotation(k0, k1), signRotation(k1, k2)];
    expect(verifyWithRotations(msg, sign(msg, k2), k0.publicKey, chain)).toEqual({ key: k2.publicKey, hops: 2 });
    // The old key no longer signs once it has rotated away.
    expect(() => verifyWithRotations(msg, sign(msg, k0), k0.publicKey, chain)).toThrow(MinisignError);
    // A verifier already pinned to K1 starts mid-chain.
    expect(resolveRotations(k1.publicKey, chain)).toEqual({ key: k2.publicKey, hops: 1 });
  });

  it("never accepts a key that is not reachable from the pinned one", () => {
    expect(() => verifyWithRotations(msg, sign(msg, k2), k0.publicKey, [signRotation(k1, k2)])).toThrow(/key id/);
    expect(() => verifyWithRotations(msg, sign(msg, k1), k0.publicKey, [])).toThrow(MinisignError);
  });

  it("rejects a link not signed by its from key", () => {
    const forged = { from: k0.publicKey, to: k1.publicKey, signature: signRotation(k1, k1).signature };
    expect(() => resolveRotations(k0.publicKey, [forged])).toThrow(/rotation 1/);
    const wrongStatement = { from: k0.publicKey, to: k2.publicKey, signature: signRotation(k0, k1).signature };
    expect(() => resolveRotations(k0.publicKey, [wrongStatement])).toThrow(/rotation 1/);
  });

  it("caps the chain at 16 links", () => {
    const keys = Array.from({ length: 18 }, () => generateKeyPair());
    const chain = keys.slice(0, -1).map((k, i) => signRotation(k, keys[i + 1]!));
    expect(resolveRotations(keys[0]!.publicKey, chain.slice(0, 16)).hops).toBe(16);
    expect(() => resolveRotations(keys[0]!.publicKey, chain)).toThrow(/more than 16/);
  });
});
