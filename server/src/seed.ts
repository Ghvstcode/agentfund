/** Dev-only convenience: a dev user, an API key and (given SEED_REPO_URL) a project. */
import { createContext } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { silentLogger } from "./log.js";
import { createApiKey, upsertUser } from "./services/auth.js";
import { createProject } from "./services/indexer.js";

const config = loadConfig();
if (!config.authDevLogin) {
  process.stderr.write("seed refuses to run unless dev login is enabled (AUTH_DEV_LOGIN=true)\n");
  process.exit(1);
}
const { ctx, close } = await createContext(config, { log: silentLogger });
try {
  const handle = (process.env.SEED_HANDLE ?? "dev").toLowerCase();
  const user = await upsertUser(ctx, { handle });
  const { secret } = await createApiKey(ctx, user.id, "seed");
  const out: Record<string, unknown> = { handle: user.handle, role: user.role, api_key: secret, base_url: config.baseUrl };
  if (process.env.SEED_REPO_URL) {
    const project = await createProject(ctx, { user, kind: "session" }, { repo_url: process.env.SEED_REPO_URL, ...(process.env.SEED_SLUG ? { slug: process.env.SEED_SLUG } : {}) });
    out.project = { slug: project.slug, id: project.id, pinned_commit: project.pinned_commit, pubkey_fingerprint: project.pubkey_fingerprint, tasks: project.tasks };
  }
  // The key is printed once, here, and nowhere else; it is stored hashed.
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await close();
}
