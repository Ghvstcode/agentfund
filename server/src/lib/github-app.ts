/**
 * Read-only GitHub App client for members-only instances (docs/dev/private-repos.md).
 *   JWT:   RS256, iat 60 s in the past, exp ≤ 10 min, iss = client ID or app ID
 *          (docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
 *   GET  /repos/{owner}/{repo}/installation, GET /orgs/{org}/installation   (JWT)
 *   POST /app/installations/{id}/access_tokens  { repositories, permissions } → { token, expires_at }  (one hour)
 *   GET  /orgs/{org}/members/{username}                    204 = member
 *   GET  /repos/{owner}/{repo}/collaborators/{username}/permission → { permission }
 * Tokens live in memory only, each narrowed to one repository (or one org) and to read access.
 * Membership answers (204 / 404) are cached for 15 minutes; errors are not cached.
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

const API = "https://api.github.com";
/** Minted tokens are dropped this long before GitHub expires them. */
const MARGIN_MS = 5 * 60_000;
const MEMBER_TTL_MS = 15 * 60_000;
const REPO_PERMISSIONS = { contents: "read", metadata: "read", checks: "read", pull_requests: "read" } as const;
const ORG_PERMISSIONS = { members: "read" } as const;

export class GithubAppError extends Error {}

interface Cached {
  token: string;
  expires: number;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export interface GithubAppOptions {
  /** Client ID (recommended by GitHub) or numeric app ID; used as the JWT `iss`. */
  appId: string;
  privateKey: string;
  fetch: typeof fetch;
  now?: () => number;
}

export class GithubApp {
  private readonly key: KeyObject;
  private readonly now: () => number;
  private readonly tokens = new Map<string, Cached>();
  private readonly members = new Map<string, { member: boolean; until: number }>();

  constructor(private readonly opts: GithubAppOptions) {
    try {
      this.key = createPrivateKey(opts.privateKey);
    } catch {
      throw new GithubAppError("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
    }
    this.now = opts.now ?? Date.now;
  }

  /** The app's own JWT, for the installation endpoints only. */
  jwt(): string {
    const iat = Math.floor(this.now() / 1000) - 60;
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: this.opts.appId }));
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(this.key);
    return `${head}.${body}.${b64url(sig)}`;
  }

  private async call(path: string, init: { method?: string; auth: string; body?: unknown }): Promise<Response> {
    return this.opts.fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        "user-agent": "agentfund-server",
        authorization: `Bearer ${init.auth}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async mint(cacheKey: string, installationPath: string, body: Record<string, unknown>): Promise<string | null> {
    const hit = this.tokens.get(cacheKey);
    if (hit && hit.expires - MARGIN_MS > this.now()) return hit.token;
    const inst = await this.call(installationPath, { auth: this.jwt() });
    if (inst.status === 404) return null; // the app is not installed there
    if (!inst.ok) throw new GithubAppError(`GitHub answered ${inst.status} for ${installationPath}`);
    const { id } = (await inst.json()) as { id?: unknown };
    if (typeof id !== "number") throw new GithubAppError(`no installation id for ${installationPath}`);
    const res = await this.call(`/app/installations/${id}/access_tokens`, { method: "POST", auth: this.jwt(), body });
    if (res.status === 404 || res.status === 422) return null; // repo not in the installation's selection
    if (!res.ok) throw new GithubAppError(`GitHub answered ${res.status} minting an installation token`);
    const t = (await res.json()) as { token?: unknown; expires_at?: unknown };
    const expires = typeof t.expires_at === "string" ? Date.parse(t.expires_at) : NaN;
    if (typeof t.token !== "string" || t.token === "" || !Number.isFinite(expires)) throw new GithubAppError("GitHub returned a malformed installation token");
    this.tokens.set(cacheKey, { token: t.token, expires });
    return t.token;
  }

  /** Read-only token for one `owner/repo`, or null when the app is not installed on it. */
  async repoToken(ownerRepo: string): Promise<string | null> {
    const [owner, repo] = splitRepo(ownerRepo);
    return this.mint(`repo:${owner}/${repo}`, `/repos/${owner}/${repo}/installation`, { repositories: [repo], permissions: REPO_PERMISSIONS });
  }

  private async orgToken(org: string): Promise<string | null> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(org)) throw new GithubAppError(`bad organization name ${org}`);
    return this.mint(`org:${org.toLowerCase()}`, `/orgs/${org}/installation`, { permissions: ORG_PERMISSIONS });
  }

  /** Whether `login` is a member of any of `orgs`. Cached; anything but 204 means no. */
  async isMember(orgs: string[], login: string): Promise<boolean> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return false;
    const key = login.toLowerCase();
    const hit = this.members.get(key);
    if (hit && hit.until > this.now()) return hit.member;
    let member = false;
    let definite = true;
    for (const org of orgs) {
      const token = await this.orgToken(org);
      if (!token) continue;
      const res = await this.call(`/orgs/${org}/members/${login}`, { auth: token });
      if (res.status === 204) {
        member = true;
        break;
      }
      // 404 (and the 302 GitHub sends a non-member requester) are answers; anything else is not.
      if (res.status !== 404 && res.status !== 302) definite = false;
    }
    // A GitHub outage refuses this request but is not remembered against the member.
    if (member || definite) this.members.set(key, { member, until: this.now() + MEMBER_TTL_MS });
    return member;
  }

  /** `admin`, `write`, `read` or `none` for `login` on `owner/repo`; `none` when the app cannot tell. */
  async permissionOf(ownerRepo: string, login: string): Promise<string> {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return "none";
    const token = await this.repoToken(ownerRepo);
    if (!token) return "none";
    const [owner, repo] = splitRepo(ownerRepo);
    const res = await this.call(`/repos/${owner}/${repo}/collaborators/${login}/permission`, { auth: token });
    if (!res.ok) return "none";
    const { permission } = (await res.json().catch(() => ({}))) as { permission?: unknown };
    return typeof permission === "string" ? permission : "none";
  }
}

function splitRepo(ownerRepo: string): [string, string] {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(ownerRepo);
  if (!m || m[2] === "." || m[2] === "..") throw new GithubAppError(`bad repository name ${ownerRepo}`);
  return [m[1]!, m[2]!];
}
