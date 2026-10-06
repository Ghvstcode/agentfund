import { ConfigError, loadConfig } from "./config.js";
import { runMigrations } from "./db/client.js";

try {
  const config = loadConfig();
  await runMigrations(config.databaseUrl);
  process.stdout.write("migrations applied\n");
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exit(1);
}
