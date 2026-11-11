/**
 * The only place the server shells out. Every call is `execFile("git", [...args])` — no shell —
 * with prompts, hooks, system/global config and every transport except https (and, when
 * explicitly allowed, file) disabled. Repo URLs are validated before they get near an argv.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

export class GitError extends Error {
  /** `message` is safe to show to users; the raw git output stays in `stderr` for the server log. */
  constructor(message: string, readonly stderr = "") {
    super(message);
  }
}

/** Maps git's stderr to a short message that says what the user can do about it. */
export function friendlyGitMessage(stderr: string, timedOut: boolean): string {
  const s = stderr.toLowerCase();
  if (timedOut || /timed out|timeout|transfer closed|low speed/.test(s)) return "timed out";
  if (/could not resolve host|failed to connect|connection refused|network is unreachable|could not connect|ssl|certificate|unable to look up/.test(s)) return "could not reach host";
  if (/repository .* not found|not found|does not exist|does not appear to be a git repository|no such file|authentication failed|could not read username|terminal prompts disabled|returned error: 40[134]|access denied|permission denied/.test(s)) {
    return "repository not found or no access";
  }
  if (/redirect/.test(s)) return "repository not found or no access";
  if (/protocol|transport/.test(s)) return "this kind of repository URL is not allowed";
  return "could not read the repository";
}
export class RepoUrlError extends Error {}

const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._~/-]+$/;
const FILE_URL = /^file:\/\/\/[A-Za-z0-9._~/+@ -]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

function privateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

export interface RepoRef {
  /** Canonical URL: no trailing slash, no `.git`. */
  url: string;
  /** Lower-cased canonical URL — the uniqueness / matching key. */
  key: string;
  scheme: "https" | "file";
  /** `owner/repo` for github.com URLs, else null. */
  github: string | null;
}

/** Matching key for a repo URL as written by a third party (webhook bodies, agentfund.yaml). */
export function repoKeyOf(input: string): string {
  const url = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  return url.startsWith("file://") ? url : url.toLowerCase();
}

export function parseRepoUrl(input: string, opts: { allowFile: boolean }): RepoRef {
  if (typeof input !== "string" || input.length > 512) throw new RepoUrlError("repo_url is too long");
  const url = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (url.startsWith("file://")) {
    if (!opts.allowFile) throw new RepoUrlError("file:// repositories are not enabled on this instance");
    if (!FILE_URL.test(url) || url.includes("/../") || url.endsWith("/..")) throw new RepoUrlError("repo_url is not a valid file:// URL");
    return { url, key: url, scheme: "file", github: null };
  }
  if (!HTTPS_URL.test(url) || url.includes("/../") || url.includes("//", 8)) throw new RepoUrlError("repo_url must be an https:// clone URL without credentials, query or fragment");
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new RepoUrlError("repo_url must not carry credentials");
  if (privateHost(parsed.hostname)) throw new RepoUrlError("repo_url host is not a public host name");
  const gh = parsed.hostname.toLowerCase() === "github.com" ? parsed.pathname.replace(/^\/+/, "") : null;
  if (gh !== null && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(gh)) throw new RepoUrlError("GitHub repo_url must be https://github.com/<owner>/<repo>");
  return { url, key: url.toLowerCase(), scheme: "https", github: gh ? gh.toLowerCase() : null };
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

export interface GitOptions {
  /** Receives the raw failure (command + stderr) for the server log. */
  onError?: (info: { command: string; stderr: string; timedOut: boolean }) => void;
  dataDir: string;
  allowFile: boolean;
  timeoutMs?: number;
  maxBlobBytes?: number;
  /** Read token for a github.com repository (members-only instances), or null for anonymous access. */
  token?: (repo: RepoRef) => Promise<string | null>;
}

/**
 * Environment that makes git send `token` to exactly this repository's URL. Passed through
 * GIT_CONFIG_COUNT so the token never appears in argv (and so in no process listing).
 */
export function authEnv(repo: RepoRef, token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${repo.url}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

const locks = new Map<string, Promise<unknown>>();

export class Git {
  private readonly timeoutMs: number;
  private readonly maxBlob: number;
  constructor(private readonly opts: GitOptions) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxBlob = opts.maxBlobBytes ?? 2 * 1024 * 1024;
  }

  repoDir(repo: RepoRef): string {
    return join(this.opts.dataDir, "repos", `${createHash("sha256").update(repo.key).digest("hex").slice(0, 32)}.git`);
  }

  private async remoteEnv(repo: RepoRef): Promise<Record<string, string>> {
    if (!this.opts.token || repo.github === null) return {};
    const token = await this.opts.token(repo);
    return token ? authEnv(repo, token) : {};
  }

  private run(args: string[], cwd?: string, maxBuffer = 16 * 1024 * 1024, opts: { report?: boolean; env?: Record<string, string> } = {}): Promise<Buffer> {
    const hardened = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "core.askPass=",
      "-c", "credential.helper=",
      "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always",
      "-c", `protocol.file.allow=${this.opts.allowFile ? "always" : "never"}`,
      "-c", "protocol.ext.allow=never",
      "-c", "http.followRedirects=false",
      "-c", "http.lowSpeedLimit=1000",
      "-c", "http.lowSpeedTime=30",
      "-c", "gc.auto=0",
      "-c", "safe.directory=*",
    ];
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [...hardened, ...args],
        {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer,
          encoding: "buffer",
          killSignal: "SIGKILL",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: this.opts.dataDir,
            LANG: "C",
            LC_ALL: "C",
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "/bin/echo",
            SSH_ASKPASS: "/bin/echo",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_ALLOW_PROTOCOL: this.opts.allowFile ? "https:file" : "https",
            ...opts.env,
          },
        },
        (err, stdout, stderr) => {
          if (err) {
            const text = stderr.toString("utf8").trim().slice(-2000);
            const timedOut = Boolean((err as { killed?: boolean }).killed);
            if (opts.report !== false) this.opts.onError?.({ command: `git ${args[0]}`, stderr: text, timedOut });
            reject(new GitError(friendlyGitMessage(text, timedOut), text));
          } else resolve(stdout);
        },
      );
    });
  }

  /** Serialises work on one clone within this process. */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  }

  /** Creates the bare clone if needed and fetches every branch head. */
  async fetch(repo: RepoRef): Promise<string> {
    const dir = this.repoDir(repo);
    return this.locked(dir, async () => {
      if (!existsSync(join(dir, "HEAD"))) {
        await mkdir(dir, { recursive: true });
        await this.run(["init", "--bare", "--quiet", dir]);
      }
      await this.run(["fetch", "--quiet", "--prune", "--no-tags", "--force", "--end-of-options", repo.url, "+refs/heads/*:refs/heads/*"], dir, undefined, { env: await this.remoteEnv(repo) });
      return dir;
    });
  }

  /** Default branch of the remote, from its HEAD symref. */
  async defaultBranch(repo: RepoRef): Promise<string | null> {
    const out = (await this.run(["ls-remote", "--symref", "--end-of-options", repo.url, "HEAD"], undefined, undefined, { env: await this.remoteEnv(repo) })).toString("utf8");
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
    return m && BRANCH.test(m[1]!) ? m[1]! : null;
  }

  async resolveBranch(repo: RepoRef, branch: string): Promise<string | null> {
    if (!BRANCH.test(branch) || branch.includes("..")) return null;
    try {
      const sha = (await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`], this.repoDir(repo), undefined, { report: false })).toString("utf8").trim();
      return COMMIT.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  async hasCommit(repo: RepoRef, commit: string): Promise<boolean> {
    if (!COMMIT.test(commit)) return false;
    try {
      await this.run(["cat-file", "-e", `${commit}^{commit}`], this.repoDir(repo), undefined, { report: false });
      return true;
    } catch {
      return false;
    }
  }

  /** Direct children of `dir` at `commit` (`git ls-tree`), or [] when the directory is absent. */
  async listTree(repo: RepoRef, commit: string, dir: string): Promise<TreeEntry[]> {
    if (!COMMIT.test(commit)) throw new GitError("invalid commit id");
    const out = (await this.run(["ls-tree", "-z", "--full-tree", commit, "--", `${dir.replace(/\/+$/, "")}/`], this.repoDir(repo))).toString("utf8");
    return out
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, sha] = line.slice(0, tab).split(" ") as [string, string, string];
        return { mode, type, sha, path: line.slice(tab + 1) };
      });
  }

  /** Raw bytes of `path` at `commit` (`git show <commit>:<path>`), or null when absent. */
  async readBlob(repo: RepoRef, commit: string, path: string): Promise<Buffer | null> {
    if (!COMMIT.test(commit)) throw new GitError("invalid commit id");
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\0") || path.includes(":")) throw new GitError("invalid path");
    const dir = this.repoDir(repo);
    const spec = `${commit}:${path}`;
    let type: string;
    try {
      type = (await this.run(["cat-file", "-t", spec], dir, undefined, { report: false })).toString("utf8").trim();
    } catch {
      return null;
    }
    if (type !== "blob") return null;
    const size = Number((await this.run(["cat-file", "-s", spec], dir)).toString("utf8").trim());
    if (!Number.isFinite(size) || size > this.maxBlob) throw new GitError(`${path} is larger than ${this.maxBlob} bytes`);
    return this.run(["show", "--no-textconv", spec], dir, this.maxBlob + 1024);
  }
}
