#!/usr/bin/env node
// Copies the normative contract from ../spec into server/spec so the build (and the Docker
// image) is self-contained. `--check` exits 1 when a copy has drifted instead of writing.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "spec");
const dst = join(here, "..", "spec");
const check = process.argv.includes("--check");

if (!existsSync(src)) {
  // Inside a deployed image only the copy exists; nothing to sync.
  console.log("sync-spec: ../spec not present, keeping existing copy");
  process.exit(0);
}
const files = ["openapi.yaml", ...readdirSync(join(src, "schemas")).filter((f) => f.endsWith(".json")).map((f) => `schemas/${f}`)];
let drift = 0;
for (const f of files) {
  const want = readFileSync(join(src, f));
  const have = existsSync(join(dst, f)) ? readFileSync(join(dst, f)) : null;
  if (have && have.equals(want)) continue;
  drift++;
  if (check) console.error(`sync-spec: ${f} differs from spec/`);
  else {
    mkdirSync(dirname(join(dst, f)), { recursive: true });
    writeFileSync(join(dst, f), want);
    console.log(`sync-spec: updated ${f}`);
  }
}
if (check && drift) process.exit(1);
