import { createHash } from "node:crypto";
import { expect } from "vitest";
import { signBody } from "../../src/ci/adapter.js";
import type { Schemas } from "../../src/lib/openapi.js";
import { WEBHOOK_SECRET, type CallResult, type TestApp } from "./app.js";
import { TestRepo, type ManifestSpec } from "./repo.js";

export const SHA = (c: string): string => c.repeat(40).slice(0, 40);
export const DIGEST = "a".repeat(64);

export interface Scenario {
  repo: TestRepo;
  project: Schemas["Project"];
  maintainer: string;
}

/** A maintainer registers a freshly built repo. */
export async function setupProject(t: TestApp, slug: string, manifests: ManifestSpec[], opts: { maintainer?: string; ciProvider?: "github" | "generic"; repo?: TestRepo } = {}): Promise<Scenario> {
  const repo = opts.repo ?? TestRepo.create(manifests, { name: slug, ciProvider: opts.ciProvider });
  const maintainer = await t.login(opts.maintainer ?? `${slug}-owner`.slice(0, 39));
  const res = await t.call<Schemas["Project"]>("createProject", { token: maintainer, body: { repo_url: repo.url, slug } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { repo, project: res.body, maintainer };
}

export async function claim(t: TestApp, key: string, taskId: string): Promise<Schemas["Claim"]> {
  const res = await t.call<Schemas["Claim"]>("claimTask", { token: key, path: { task_id: taskId } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

export function completedBody(c: Schemas["Claim"], overrides: Partial<Schemas["ReportCreate"]> = {}): Schemas["ReportCreate"] {
  const short = c.claim_id.slice(4, 12);
  return {
    status: "completed",
    tokens_in: 80_000,
    tokens_out: 20_000,
    cost_estimate: 1.25,
    branch: `agentfund/${c.task.task_id}-${short}`,
    pr_url: `https://example.test/${c.project}/pull/${short}`,
    head_sha: createHash("sha1").update(c.claim_id).digest("hex"),
    verify_exit_code: 0,
    log_digest: DIGEST,
    duration_seconds: 120,
    runner: "claude-code/2.1.0",
    model: "claude-test",
    ...overrides,
  };
}

export async function reportCompleted(t: TestApp, key: string, c: Schemas["Claim"], overrides: Partial<Schemas["ReportCreate"]> = {}): Promise<Schemas["Report"]> {
  const res = await t.call<Schemas["Report"]>("reportClaim", { token: key, path: { claim_id: c.claim_id }, body: completedBody(c, overrides) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** Posts a signed generic CI result. */
export async function genericCi(
  t: TestApp,
  repoUrl: string,
  report: Pick<Schemas["Report"], "branch" | "head_sha">,
  result: { conclusion?: "success" | "failure" | "cancelled"; merged?: boolean; closed?: boolean; run_url?: string },
): Promise<CallResult<{ matched: boolean }>> {
  const raw = JSON.stringify({ provider: "generic", repo_url: repoUrl, branch: report.branch, head_sha: report.head_sha, conclusion: result.conclusion ?? "success", run_url: result.run_url ?? "https://ci.example/run/1", ...(result.merged !== undefined ? { merged: result.merged } : {}), ...(result.closed !== undefined ? { closed: result.closed } : {}) });
  return t.call<{ matched: boolean }>("ciWebhook", { raw, headers: { "x-agentfund-signature": signBody(WEBHOOK_SECRET, raw) } });
}

export async function getProject(t: TestApp, slug: string): Promise<Schemas["Project"]> {
  return (await t.call<Schemas["Project"]>("getProject", { path: { slug } })).body;
}

export async function getTask(t: TestApp, slug: string, id: string): Promise<Schemas["Task"]> {
  const res = await t.call<{ items: Schemas["Task"][] }>("listTasks", { path: { slug }, query: { limit: 100 } });
  const task = res.body.items.find((x) => x.task_id === id);
  if (!task) throw new Error(`task ${id} not found`);
  return task;
}
