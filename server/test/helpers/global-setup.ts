import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

let container: StartedPostgreSqlContainer | undefined;

/** One Postgres for the whole run; every test file gets its own database inside it. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env.TEST_DATABASE_URL) {
    project.provide("pgUrl", process.env.TEST_DATABASE_URL);
    return async () => {};
  }
  container = await new PostgreSqlContainer("postgres:17-alpine").withCommand(["postgres", "-c", "max_connections=300", "-c", "fsync=off"]).start();
  project.provide("pgUrl", container.getConnectionUri());
  return async () => {
    await container?.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    pgUrl: string;
  }
}
