/**
 * GitHub webhook adapter. Payload shapes follow
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads :
 *  - workflow_run  { action, workflow_run: { id, head_branch, head_sha, conclusion, html_url, head_repository }, repository }
 *  - check_suite   { action, check_suite: { id, head_branch (null for pushes to forks), head_sha, conclusion }, repository }
 *  - pull_request  { action: "closed", number, pull_request: { merged, html_url, head: { ref, sha }, base: { repo } }, repository }
 *  - push          { ref, after, repository }
 *  - ping          { zen, hook_id }
 * `repository` is always the repo the webhook is installed on — the project repo — also for
 * runs triggered by a pull request from a fork, whose branch and SHA arrive in head_branch / head_sha.
 */
import type { Evidence } from "../services/ci.js";
import { PayloadError, type CiAdapter, type Delivery } from "./adapter.js";

const SHA = /^[0-9a-f]{40}$/;
type Json = Record<string, unknown>;

const obj = (v: unknown, what: string): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PayloadError(`${what} is missing`);
  return v as Json;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new PayloadError(`${what} is missing`);
  return v;
};
const optStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const sha = (v: unknown, what: string): string => {
  const s = str(v, what);
  if (!SHA.test(s)) throw new PayloadError(`${what} is not a commit id`);
  return s;
};

export const githubRepoKey = (fullName: string): string => `https://github.com/${fullName.toLowerCase()}`;

function repoKey(payload: Json): string {
  return githubRepoKey(str(obj(payload.repository, "repository").full_name, "repository.full_name"));
}

export const githubAdapter: CiAdapter = {
  name: "github",
  signatureHeader: "x-hub-signature-256",
  accepts: (headers) => headers.has("x-github-event"),
  parse(headers, body): Delivery {
    const event = headers.get("x-github-event") ?? "";
    const payload = obj(body, "payload");
    const base = { provider: "github", source: "webhook" } as const;
    switch (event) {
      case "ping":
        return { repoKey: null, evidence: [] };
      case "push":
        return { repoKey: repoKey(payload), evidence: [], pushedRef: str(payload.ref, "ref") };
      case "workflow_run": {
        if (payload.action !== "completed") return { repoKey: repoKey(payload), evidence: [] };
        const run = obj(payload.workflow_run, "workflow_run");
        const ev: Evidence = {
          ...base,
          kind: "ci",
          runKey: `github:workflow_run:${String(run.id)}`,
          branch: optStr(run.head_branch),
          headSha: sha(run.head_sha, "workflow_run.head_sha"),
          conclusion: str(run.conclusion, "workflow_run.conclusion"),
          runUrl: optStr(run.html_url),
          prUrl: null,
        };
        return { repoKey: repoKey(payload), evidence: [ev] };
      }
      case "check_suite": {
        if (payload.action !== "completed") return { repoKey: repoKey(payload), evidence: [] };
        const suite = obj(payload.check_suite, "check_suite");
        const ev: Evidence = {
          ...base,
          kind: "ci",
          runKey: `github:check_suite:${String(suite.id)}`,
          // null when the commit was pushed to a fork: the SHA alone identifies the report then.
          branch: optStr(suite.head_branch),
          headSha: sha(suite.head_sha, "check_suite.head_sha"),
          conclusion: str(suite.conclusion, "check_suite.conclusion"),
          runUrl: null,
          prUrl: null,
        };
        return { repoKey: repoKey(payload), evidence: [ev] };
      }
      case "pull_request": {
        if (payload.action !== "closed") return { repoKey: repoKey(payload), evidence: [] };
        const pr = obj(payload.pull_request, "pull_request");
        const head = obj(pr.head, "pull_request.head");
        const ev: Evidence = {
          ...base,
          kind: "pr",
          runKey: `github:pr:${String(pr.number ?? payload.number)}`,
          branch: str(head.ref, "pull_request.head.ref"),
          headSha: sha(head.sha, "pull_request.head.sha"),
          conclusion: pr.merged === true ? "merged" : "closed",
          runUrl: null,
          prUrl: str(pr.html_url, "pull_request.html_url"),
        };
        return { repoKey: repoKey(payload), evidence: [ev] };
      }
      default:
        return { repoKey: null, evidence: [] };
    }
  },
};
