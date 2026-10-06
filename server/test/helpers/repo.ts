/** Throwaway git repositories with signed locks, for indexer and end-to-end tests. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Rotation } from "../../src/lib/minisign.js";
import { generateKeyPair, sign, type KeyPair } from "./minisign.js";

export interface ManifestSpec {
  id: string;
  title?: string;
  max_tokens?: number;
  depends_on?: string[];
  prompt?: string;
}

export function manifestYaml(m: ManifestSpec): string {
  const lines = [
    "spec_version: 1",
    `id: ${m.id}`,
    `title: ${JSON.stringify(m.title ?? `Task ${m.id}`)}`,
    `prompt: ${JSON.stringify(m.prompt ?? `Do ${m.id}.`)}`,
    "scope:",
    "  write: [src/**]",
    "verify: \"true\"",
    `max_tokens: ${m.max_tokens ?? 1_000_000}`,
  ];
  if (m.depends_on?.length) lines.push(`depends_on: [${m.depends_on.join(", ")}]`);
  return `${lines.join("\n")}\n`;
}

export class TestRepo {
  readonly dir: string;
  readonly url: string;
  key: KeyPair;
  rotations: Rotation[] = [];
  descriptor: Record<string, unknown>;

  constructor(opts: { name?: string; key?: KeyPair; ciProvider?: "github" | "generic"; repoUrl?: string; tokenGoal?: number } = {}) {
    this.dir = mkdtempSync(join(tmpdir(), "af-repo-"));
    this.url = `file://${this.dir}`;
    this.key = opts.key ?? generateKeyPair();
    this.descriptor = {
      spec_version: 1,
      name: opts.name ?? "demo",
      description: "A demo project for tests.",
      repo_url: opts.repoUrl ?? this.url,
      ci_provider: opts.ciProvider ?? "generic",
      pubkey: this.key.publicKey,
      language: "python",
      tags: ["demo", "tests"],
      ...(opts.tokenGoal ? { token_goal: opts.tokenGoal } : {}),
    };
    this.git("init", "--quiet", "-b", "main");
    this.write("README.md", "# demo\n");
    this.writeDescriptor();
  }

  git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  }

  write(path: string, content: string | Uint8Array): void {
    const file = join(this.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  read(path: string): Buffer {
    return readFileSync(join(this.dir, path));
  }

  remove(path: string): void {
    unlinkSync(join(this.dir, path));
  }

  writeDescriptor(): void {
    this.descriptor.pubkey = this.key.publicKey;
    this.write("agentfund.yaml", `${Object.entries(this.descriptor).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n`);
  }

  manifest(m: ManifestSpec): void {
    this.write(`tasks/${m.id}.yaml`, manifestYaml(m));
  }

  /** Rewrites MANIFEST.lock from the files on disk and signs it with the current key. */
  signLock(opts: { key?: KeyPair; legacy?: boolean } = {}): void {
    const tasks = join(this.dir, "tasks");
    const files = existsSync(tasks) ? readdirSync(tasks).filter((f) => f.endsWith(".yaml")).sort() : [];
    const lock = {
      lock_version: 1,
      spec_version: 1,
      manifests: files.map((f) => ({ path: `tasks/${f}`, id: f.replace(/\.yaml$/, ""), sha256: createHash("sha256").update(readFileSync(join(tasks, f))).digest("hex") })),
      rotations: this.rotations,
    };
    const bytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    this.write("tasks/MANIFEST.lock", bytes);
    this.write("tasks/MANIFEST.lock.minisig", sign(bytes, opts.key ?? this.key, { legacy: opts.legacy }));
  }

  commit(message = "update"): string {
    this.git("add", "-A");
    this.git("commit", "--quiet", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  head(): string {
    return this.git("rev-parse", "HEAD");
  }

  /** Convenience: manifests + signed lock + commit. */
  static create(manifests: ManifestSpec[], opts: ConstructorParameters<typeof TestRepo>[0] = {}): TestRepo {
    const repo = new TestRepo(opts);
    for (const m of manifests) repo.manifest(m);
    repo.signLock();
    repo.commit("initial");
    return repo;
  }
}
