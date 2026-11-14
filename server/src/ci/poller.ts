/**
 * Poller (capability `ci_poll`): for reports awaiting CI or a merge on GitHub projects, asks
 * the GitHub REST API directly, so an instance GitHub cannot reach still confirms delivery.
 *   GET /repos/{owner}/{repo}/commits/{ref}/check-runs   (docs.github.com/en/rest/checks/runs)
 *   GET /repos/{owner}/{repo}/pulls/{pull_number}        (docs.github.com/en/rest/pulls/pulls)
 * Check runs for a pull request from a fork are created in the base (project) repository, so
 * the head SHA is always looked up there.
 */
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { rows } from "../db/client.js";
import { recordEvidence, type Evidence } from "../services/ci.js";

const API = "https://api.github.com";
const PASSING = new Set(["success", "neutral", "skipped"]);

interface CheckRun {
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
}
interface PullRequest {
  state?: string;
  merged?: boolean;
  html_url?: string;
  head?: { ref?: string; sha?: string };
  base?: { repo?: { full_name?: string } };
}

class RateLimited extends Error {}

/** The App's read token for the repo when it is installed there, else GITHUB_TOKEN (public repos). */
async function tokenFor(ctx: AppContext, repo: string): Promise<string | undefined> {
  const app = ctx.githubApp ? await ctx.githubApp.repoToken(repo).catch((err: unknown) => (ctx.log.warn("installation token failed", { repo, err }), null)) : null;
  return app ?? ctx.config.githubToken;
}

async function gh<T>(ctx: AppContext, path: string, token: string | undefined): Promise<T | null> {
  const res = await ctx.fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      "user-agent": "agentfund-server",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) throw new RateLimited(`GitHub rate limit hit on ${path}`);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** "All completed runs for the head SHA succeeded" — and none is still running. */
export function judgeCheckRuns(runs: CheckRun[]): { conclusion: "success" | "failure"; url: string | null } | null {
  const failed = runs.find((r) => r.status === "completed" && !PASSING.has(r.conclusion ?? ""));
  if (failed) return { conclusion: "failure", url: failed.html_url ?? null };
  if (runs.length === 0 || runs.some((r) => r.status !== "completed")) return null;
  const ok = runs.find((r) => r.conclusion === "success");
  return ok ? { conclusion: "success", url: ok.html_url ?? null } : null;
}

export function parsePrUrl(prUrl: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([0-9]{1,10})\/?$/.exec(prUrl);
  return m ? { repo: m[1]!.toLowerCase(), number: Number(m[2]) } : null;
}

interface Pending {
  id: string;
  project_id: string;
  repo_key: string;
  delivery: string;
  branch: string;
  head_sha: string;
  pr_url: string;
}

export async function pollOnce(ctx: AppContext): Promise<{ checked: number; applied: number }> {
  const pending = await rows<Pending>(
    ctx.db,
    sql`SELECT r.id, r.project_id, p.repo_key, r.delivery, r.branch, r.head_sha, r.pr_url
        FROM reports r JOIN projects p ON p.id = r.project_id
        WHERE r.delivery IN ('pending_ci', 'delivered') AND r.status = 'completed' AND NOT r.flagged_late
          AND p.ci_provider = 'github' AND p.status <> 'removed' AND p.repo_key LIKE 'https://github.com/%'
        ORDER BY r.id DESC LIMIT 200`,
  );
  let applied = 0;
  try {
    for (const r of pending) {
      const repo = r.repo_key.slice("https://github.com/".length);
      const token = await tokenFor(ctx, repo);
      const projectId = Number(r.project_id);
      const found: Evidence[] = [];
      if (r.delivery === "pending_ci") {
        const runs: CheckRun[] = [];
        for (let page = 1; page <= 5; page++) {
          const body = await gh<{ total_count?: number; check_runs?: CheckRun[] }>(ctx, `/repos/${repo}/commits/${r.head_sha}/check-runs?per_page=100&page=${page}`, token);
          runs.push(...(body?.check_runs ?? []));
          if (!body || runs.length >= (body.total_count ?? 0) || (body.check_runs ?? []).length === 0) break;
        }
        const verdict = judgeCheckRuns(runs);
        if (verdict) {
          found.push({ provider: "github", source: "poll", kind: "ci", runKey: `github:checks:${r.head_sha}`, branch: r.branch, headSha: r.head_sha, conclusion: verdict.conclusion, runUrl: verdict.url, prUrl: null });
        }
      }
      // The PR must live in the project repo and carry the reported branch; anything else is not evidence.
      const pr = parsePrUrl(r.pr_url);
      if (pr && pr.repo === repo) {
        const body = await gh<PullRequest>(ctx, `/repos/${repo}/pulls/${pr.number}`, token);
        if (body && body.state === "closed" && body.head?.ref === r.branch && (body.base?.repo?.full_name ?? "").toLowerCase() === repo) {
          found.push({ provider: "github", source: "poll", kind: "pr", runKey: `github:pr:${pr.number}`, branch: r.branch, headSha: body.head?.sha ?? r.head_sha, conclusion: body.merged === true ? "merged" : "closed", runUrl: null, prUrl: r.pr_url });
        }
      }
      for (const ev of found) {
        const out = await recordEvidence(ctx, projectId, ev);
        if (out.matched) applied++;
      }
    }
  } catch (err) {
    if (err instanceof RateLimited) ctx.log.warn("ci poll paused", { reason: err.message, hint: ctx.config.githubToken ? undefined : "set GITHUB_TOKEN for a higher rate limit" });
    else throw err;
  }
  return { checked: pending.length, applied };
}
