# AgentFund server

The self-hostable API behind an AgentFund instance: it indexes signed task sets, hands out
claims, receives reports, listens to CI and adds up the ledger. It also serves the built
[web UI](../web/README.md) and injects per-page metadata into it.

It is **untrusted middleware by design**. Workers verify every signature and hash themselves,
so a compromised server can stall work but cannot change what runs. Keep that property when
you change this package. Background: [Concepts](../docs/concepts.md),
[Security](../docs/SECURITY.md).

Running an instance (Docker Compose, configuration, GitHub login, CI confirmation, backups)
is covered in [Self-hosting](../docs/self-hosting.md). This page is for working on the code.

## Develop

```sh
pnpm install
docker run -d --name af-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=agentfund -p 127.0.0.1:5433:5432 postgres:17-alpine
export DATABASE_URL=postgres://postgres:dev@127.0.0.1:5433/agentfund AUTH_DEV_LOGIN=true
pnpm --filter server dev        # tsx watch on http://localhost:8787; migrations apply at start
```

Settings are read from the environment, and from `../.env` when it exists;
[`.env.example`](../.env.example) documents every one. For the UI in the same loop, run
`pnpm --filter web dev` in another terminal. For the whole product with a worker run in one
command, use `make demo` from the repository root.

| Script | Does |
| --- | --- |
| `dev` | Watch and restart |
| `build`, `start` | Compile to `dist/`, run the compiled server |
| `test` | Vitest. Starts Postgres with Testcontainers, so Docker must be running |
| `lint` | ESLint and `tsc --noEmit` |
| `generate` | Copy the spec in and regenerate `src/generated/openapi.d.ts` |
| `db:generate`, `db:migrate` | Create a migration from `src/db/schema.ts`; apply migrations without starting |
| `seed` | Dev login only: create a user, print an API key, register `SEED_REPO_URL` when set |

## Layout

```
src/main.ts, bootstrap.ts   process entry; wiring, migrations, background loops
src/config.ts               every environment variable, parsed and validated once
src/http/                   Hono app, routes (the v1 API), middleware, SPA + metadata pages
src/services/               auth, projects, indexer, tasks, claims, ledger, ci, events, stream, og, federation
src/ci/                     CiAdapter implementations: github, generic; the poller
src/lib/                    minisign (verify, and sign with the instance key), git, ids, problem+json errors, schemas
src/db/                     Drizzle schema and client; migrations live in drizzle/
spec/                       a copy of ../spec, synced by `build` and `generate`
test/                       API, ledger and indexer tests against a real Postgres
```

## The rules this package lives by

- **The spec is the contract.** [`spec/openapi.yaml`](../spec/openapi.yaml) and
  [`spec/protocol.md`](../spec/protocol.md) come first; change them, run
  `pnpm --filter server generate`, then change the code.
- **No private endpoints.** The web UI uses only the public v1 API, so anyone can host their own.
- **Ledgers are computed from evidence rows**, never from stored totals, and the `events`
  table is append-only, enforced in the database.
- **Delivered needs the CI provider's word**: a webhook signed with the project's secret, or
  the server's own poll of GitHub. A worker's report alone never delivers anything.

- **A peer's word is a peer's word.** Whatever federation fetches is validated, stored apart
  (`remote_*` tables), served under the peer's name and never joined into a ledger query.

The acceptance test for all of it is [`scripts/e2e.sh`](../scripts/e2e.sh): `make e2e`.
Federation has its own, with two instances: `make e2e-federation`.
