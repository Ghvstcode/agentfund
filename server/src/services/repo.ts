/**
 * Manifest-spec verification steps 2–3 against a commit in a clone: lock signature (with the
 * rotation chain from the registered key), lock schema, exact file set, per-file hashes,
 * strict YAML, manifest schema, id/path agreement and the dependency graph.
 * Pure with respect to the database — the indexer and `POST /v1/projects/preview` share it.
 */
import { createHash } from "node:crypto";
import { repoKeyOf, type Git, type RepoRef } from "../lib/git.js";
import { fingerprint, MinisignError, parsePublicKey, verifyWithRotations } from "../lib/minisign.js";
import { SchemaError, validateAgentfund, validateLock, validateManifest, type AgentfundDoc, type LockDoc, type ManifestDoc } from "../lib/schemas.js";
import { parseStrictYaml, StrictYamlError } from "../lib/yaml.js";

export const LOCK_PATH = "tasks/MANIFEST.lock";
export const SIG_PATH = "tasks/MANIFEST.lock.minisig";
const MANIFEST_FILE = /^tasks\/[^/]+\.yaml$/;
const MAX_MANIFESTS = 2000;

export class VerificationError extends Error {
  constructor(message: string, readonly stage: "fetch" | "descriptor" | "signature" | "content") {
    super(message);
  }
}

export interface VerifiedManifest {
  id: string;
  path: string;
  contentHash: string;
  doc: ManifestDoc;
}

export interface VerifiedLock {
  commit: string;
  lockSha256: string;
  lock: LockDoc;
  /** Key the lock is signed with after following rotations from the pinned key. */
  signingKey: string;
  rotationHops: number;
  manifests: VerifiedManifest[];
  tokenTotal: number;
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function describe(err: unknown): string {
  if (err instanceof SchemaError || err instanceof StrictYamlError || err instanceof MinisignError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Reads and validates `agentfund.yaml` at a commit. */
export async function readDescriptor(git: Git, repo: RepoRef, commit: string): Promise<AgentfundDoc> {
  const raw = await git.readBlob(repo, commit, "agentfund.yaml");
  if (!raw) throw new VerificationError("agentfund.yaml is missing at the repository root", "descriptor");
  try {
    const doc = validateAgentfund(parseStrictYaml(raw.toString("utf8")));
    parsePublicKey(doc.pubkey);
    return doc;
  } catch (err) {
    throw new VerificationError(`agentfund.yaml is invalid: ${describe(err)}`, "descriptor");
  }
}

/** Steps 2–3 at `commit` against `pinnedKey`. Throws VerificationError on the first failure. */
export async function verifyCommit(git: Git, repo: RepoRef, commit: string, pinnedKey: string): Promise<VerifiedLock> {
  const [lockBytes, sigBytes] = await Promise.all([git.readBlob(repo, commit, LOCK_PATH), git.readBlob(repo, commit, SIG_PATH)]);
  if (!lockBytes) throw new VerificationError(`${LOCK_PATH} is missing`, "signature");
  if (!sigBytes) throw new VerificationError(`${SIG_PATH} is missing`, "signature");

  // The rotation chain lives inside the lock, so the lock is parsed before its signature can
  // be checked — but nothing from it is trusted until the signature verifies.
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockBytes.toString("utf8"));
  } catch {
    throw new VerificationError(`${LOCK_PATH} is not valid JSON`, "signature");
  }
  let lock: LockDoc;
  try {
    lock = validateLock(parsed);
  } catch (err) {
    throw new VerificationError(describe(err), "content");
  }
  let signingKey: string;
  let rotationHops: number;
  try {
    const r = verifyWithRotations(lockBytes, sigBytes.toString("utf8"), pinnedKey, lock.rotations ?? []);
    signingKey = r.key;
    rotationHops = r.hops;
  } catch (err) {
    throw new VerificationError(`lock signature does not verify against the registered key ${fingerprint(pinnedKey)}: ${describe(err)}`, "signature");
  }

  if (lock.manifests.length > MAX_MANIFESTS) throw new VerificationError(`more than ${MAX_MANIFESTS} manifests`, "content");
  const paths = lock.manifests.map((m) => m.path);
  for (let i = 1; i < paths.length; i++) {
    if (paths[i - 1]! >= paths[i]!) throw new VerificationError("lock manifests are not sorted by path (or contain a duplicate)", "content");
  }
  const ids = new Set<string>();
  for (const m of lock.manifests) {
    if (m.path !== `tasks/${m.id}.yaml`) throw new VerificationError(`lock entry ${m.path} does not match its id ${m.id}`, "content");
    if (ids.has(m.id)) throw new VerificationError(`duplicate manifest id ${m.id}`, "content");
    ids.add(m.id);
  }

  const tree = await git.listTree(repo, commit, "tasks");
  const files = tree.filter((e) => MANIFEST_FILE.test(e.path));
  const listed = new Set(paths);
  for (const f of files) {
    if (f.type !== "blob" || f.mode === "120000") throw new VerificationError(`${f.path} is not a regular file`, "content");
    if (!listed.has(f.path)) throw new VerificationError(`${f.path} is not listed in the lock`, "content");
  }
  const present = new Set(files.map((f) => f.path));
  for (const p of paths) if (!present.has(p)) throw new VerificationError(`${p} is listed in the lock but missing from the commit`, "content");

  const manifests: VerifiedManifest[] = [];
  for (const entry of lock.manifests) {
    const raw = await git.readBlob(repo, commit, entry.path);
    if (!raw) throw new VerificationError(`${entry.path} is missing`, "content");
    const hash = sha256(raw);
    if (hash !== entry.sha256) throw new VerificationError(`${entry.path} does not match its sha256 in the lock`, "content");
    let doc: ManifestDoc;
    try {
      doc = validateManifest(parseStrictYaml(raw.toString("utf8")), entry.path);
    } catch (err) {
      throw new VerificationError(`${entry.path}: ${describe(err)}`, "content");
    }
    if (doc.id !== entry.id) throw new VerificationError(`${entry.path}: id "${doc.id}" does not match the file name`, "content");
    manifests.push({ id: entry.id, path: entry.path, contentHash: hash, doc });
  }

  const deps = new Map(manifests.map((m) => [m.id, m.doc.depends_on ?? []]));
  for (const [id, list] of deps) {
    for (const d of list) {
      if (d === id) throw new VerificationError(`${id} depends on itself`, "content");
      if (!deps.has(d)) throw new VerificationError(`${id} depends on unknown task ${d}`, "content");
    }
  }
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new VerificationError(`dependency cycle: ${[...trail, id].join(" → ")}`, "content");
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of deps.keys()) visit(id, []);

  return {
    commit,
    lockSha256: sha256(lockBytes),
    lock,
    signingKey,
    rotationHops,
    manifests,
    tokenTotal: manifests.reduce((n, m) => n + m.doc.max_tokens, 0),
  };
}

export interface Inspection {
  errors: string[];
  commit?: string;
  baseBranch?: string;
  descriptor?: AgentfundDoc;
  pubkeyFingerprint?: string;
  signatureValid?: boolean;
  verified?: VerifiedLock;
}

/**
 * Everything `preview` and `create` need to know about a repo that is not registered yet:
 * fetch, find the base branch, read the descriptor, verify the lock against the descriptor's
 * key. Never throws for repo problems; they are collected in `errors`.
 */
export async function inspectRepo(git: Git, repo: RepoRef): Promise<Inspection> {
  const out: Inspection = { errors: [] };
  let head: string | null;
  try {
    head = await git.defaultBranch(repo);
    await git.fetch(repo);
  } catch (err) {
    out.errors.push(`could not fetch the repository: ${describe(err)}`);
    return out;
  }
  const candidates = [...new Set([head, "main", "master"].filter((b): b is string => Boolean(b)))];
  let branch: string | undefined;
  let commit: string | undefined;
  for (const b of candidates) {
    const sha = await git.resolveBranch(repo, b);
    if (sha) {
      branch = b;
      commit = sha;
      break;
    }
  }
  if (!branch || !commit) {
    out.errors.push("the repository has no branch to index");
    return out;
  }
  try {
    let descriptor = await readDescriptor(git, repo, commit);
    const declared = descriptor.base_branch ?? "main";
    if (declared !== branch) {
      const sha = await git.resolveBranch(repo, declared);
      if (!sha) throw new VerificationError(`agentfund.yaml names base_branch "${declared}", which does not exist`, "descriptor");
      branch = declared;
      commit = sha;
      descriptor = await readDescriptor(git, repo, commit);
      if ((descriptor.base_branch ?? "main") !== declared) throw new VerificationError(`agentfund.yaml on "${declared}" names a different base_branch`, "descriptor");
    }
    out.descriptor = descriptor;
    out.baseBranch = branch;
    out.commit = commit;
    out.pubkeyFingerprint = fingerprint(descriptor.pubkey);
  } catch (err) {
    out.commit = commit;
    out.baseBranch = branch;
    out.errors.push(describe(err));
    return out;
  }
  if (repoKeyOf(out.descriptor.repo_url) !== repo.key) {
    out.errors.push(`agentfund.yaml repo_url (${out.descriptor.repo_url}) is not the repository being registered (${repo.url})`);
  }
  try {
    out.verified = await verifyCommit(git, repo, commit, out.descriptor.pubkey);
    out.signatureValid = true;
    if (out.verified.manifests.length === 0) out.errors.push("the lock lists no manifests");
  } catch (err) {
    out.signatureValid = err instanceof VerificationError && err.stage === "content";
    out.errors.push(describe(err));
  }
  return out;
}
