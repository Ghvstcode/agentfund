#!/usr/bin/env node
// Phase-1 acceptance: the JSON Schemas compile, and every example project under
// examples/ validates against them (manifests, agentfund.yaml, and the lock when present).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const schema = (n) => JSON.parse(readFileSync(join(root, "spec/schemas", n), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false });
addFormats(ajv);
const validators = {
  manifest: ajv.compile(schema("manifest.schema.json")),
  agentfund: ajv.compile(schema("agentfund.schema.json")),
  lock: ajv.compile(schema("lock.schema.json")),
};

let failures = 0;
const fail = (file, msg) => { failures++; console.error(`✗ ${file}: ${msg}`); };
const check = (kind, file, doc) => {
  const v = validators[kind];
  if (v(doc)) { console.log(`✓ ${file}`); return true; }
  for (const e of v.errors) fail(file, `${e.instancePath || "/"} ${e.message}`);
  return false;
};

const examples = join(root, "examples");
for (const name of readdirSync(examples)) {
  const dir = join(examples, name);
  if (!statSync(dir).isDirectory() || !existsSync(join(dir, "agentfund.yaml"))) continue;
  check("agentfund", `examples/${name}/agentfund.yaml`, parse(readFileSync(join(dir, "agentfund.yaml"), "utf8")));
  const tasks = join(dir, "tasks");
  const files = readdirSync(tasks).filter((f) => f.endsWith(".yaml")).sort();
  const ids = new Set(files.map((f) => basename(f, ".yaml")));
  const hashes = new Map();
  for (const f of files) {
    const raw = readFileSync(join(tasks, f));
    hashes.set(`tasks/${f}`, createHash("sha256").update(raw).digest("hex"));
    const doc = parse(raw.toString("utf8"));
    const rel = `examples/${name}/tasks/${f}`;
    if (!check("manifest", rel, doc)) continue;
    if (doc.id !== basename(f, ".yaml")) fail(rel, `id "${doc.id}" does not match file name`);
    for (const d of doc.depends_on ?? []) if (!ids.has(d)) fail(rel, `depends_on unknown task "${d}"`);
  }
  const lockPath = join(tasks, "MANIFEST.lock");
  if (existsSync(lockPath)) {
    const rel = `examples/${name}/tasks/MANIFEST.lock`;
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (check("lock", rel, lock)) {
      const listed = new Map(lock.manifests.map((m) => [m.path, m.sha256]));
      for (const [p, h] of hashes) {
        if (!listed.has(p)) fail(rel, `${p} is not listed`);
        else if (listed.get(p) !== h) fail(rel, `${p} hash mismatch`);
      }
      for (const p of listed.keys()) if (!hashes.has(p)) fail(rel, `${p} listed but missing`);
      if (!existsSync(lockPath + ".minisig")) fail(rel, "MANIFEST.lock.minisig is missing");
    }
  }
}

if (failures) { console.error(`\n${failures} problem(s)`); process.exit(1); }
console.log("\nspec: all examples validate");
