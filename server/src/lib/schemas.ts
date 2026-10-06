/** Ajv validators for the manifest-spec JSON Schemas (draft 2020-12), loaded from the bundled copy of spec/schemas. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { SPEC_DIR } from "../paths.js";
import { formatErrors } from "./openapi.js";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

export interface ManifestDoc {
  spec_version: 1;
  id: string;
  title: string;
  prompt: string;
  scope: { write: string[]; read?: string[] };
  verify: string;
  max_tokens: number;
  timeout_minutes?: number;
  depends_on?: string[];
  base_branch?: string;
}

export interface AgentfundDoc {
  spec_version: 1;
  name: string;
  description: string;
  repo_url: string;
  ci_provider: "github" | "generic";
  pubkey: string;
  base_branch?: string;
  homepage?: string;
  language?: string;
  tags?: string[];
  token_goal?: number;
}

export interface LockDoc {
  lock_version: 1;
  spec_version: 1;
  manifests: { path: string; id: string; sha256: string }[];
  rotations?: { from: string; to: string; signature: string }[];
}

interface Validators {
  manifest: ValidateFunction<ManifestDoc>;
  agentfund: ValidateFunction<AgentfundDoc>;
  lock: ValidateFunction<LockDoc>;
}

let cached: Validators | undefined;

function load(): Validators {
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false });
  addFormats(ajv);
  const read = (name: string) => JSON.parse(readFileSync(join(SPEC_DIR, "schemas", name), "utf8")) as object;
  cached = {
    manifest: ajv.compile<ManifestDoc>(read("manifest.schema.json")),
    agentfund: ajv.compile<AgentfundDoc>(read("agentfund.schema.json")),
    lock: ajv.compile<LockDoc>(read("lock.schema.json")),
  };
  return cached;
}

export class SchemaError extends Error {
  constructor(what: string, readonly problems: string[]) {
    super(`${what}: ${problems.slice(0, 5).join("; ")}`);
  }
}

function check<T>(kind: keyof Validators, what: string, doc: unknown): T {
  const v = load()[kind] as ValidateFunction;
  if (v(doc)) return doc as T;
  throw new SchemaError(what, formatErrors(v.errors).map((e) => `${e.path} ${e.message}`));
}

export const validateManifest = (doc: unknown, what = "manifest"): ManifestDoc => check<ManifestDoc>("manifest", what, doc);
export const validateAgentfund = (doc: unknown, what = "agentfund.yaml"): AgentfundDoc => check<AgentfundDoc>("agentfund", what, doc);
export const validateLock = (doc: unknown, what = "tasks/MANIFEST.lock"): LockDoc => check<LockDoc>("lock", what, doc);
