import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (`server/`), valid for both `src/` under tsx and `dist/` after build. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_DIR = join(PACKAGE_ROOT, "spec");
export const MIGRATIONS_DIR = join(PACKAGE_ROOT, "drizzle");
