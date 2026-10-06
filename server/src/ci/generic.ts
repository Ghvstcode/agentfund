import { repoKeyOf } from "../lib/git.js";
import type { Schemas } from "../lib/openapi.js";
import type { Evidence } from "../services/ci.js";
import type { CiAdapter, Delivery } from "./adapter.js";

/** Generic adapter: the body is a `GenericCiResult` (schema-validated by the caller before `parse`). */
export const genericAdapter: CiAdapter = {
  name: "generic",
  signatureHeader: "x-agentfund-signature",
  accepts: (headers) => headers.has("x-agentfund-signature"),
  claimedRepo(payload) {
    const url = (payload as { repo_url?: unknown } | null)?.repo_url;
    return typeof url === "string" && url.length <= 512 ? repoKeyOf(url) : null;
  },
  parse(_headers, body): Delivery {
    const r = body as Schemas["GenericCiResult"];
    const base = { provider: "generic", source: "webhook", branch: r.branch, headSha: r.head_sha, prUrl: null } as const;
    const evidence: Evidence[] = [
      { ...base, kind: "ci", runKey: `generic:ci:${r.branch}:${r.head_sha}:${r.run_url ?? ""}`.slice(0, 900), conclusion: r.conclusion, runUrl: r.run_url ?? null },
    ];
    if (r.merged === true) evidence.push({ ...base, kind: "pr", runKey: `generic:pr:${r.branch}:${r.head_sha}`, conclusion: "merged", runUrl: null });
    else if (r.closed === true) evidence.push({ ...base, kind: "pr", runKey: `generic:pr:${r.branch}:${r.head_sha}`, conclusion: "closed", runUrl: null });
    return { repoKey: repoKeyOf(r.repo_url), evidence };
  },
};
