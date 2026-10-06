# Self-hosting an AgentFund instance

New here? `make demo` runs a throwaway instance with a sample project and a worker in one
command ([Quickstart](quickstart.md)); [Concepts](concepts.md) explains what the server is and
is not trusted with. This page is about running one for real.

One container serves the API (`/v1`), the live stream, the web UI and the discovery routes
(`/sitemap.xml`, `/feed.atom`, `/og/<slug>.png`). It needs Postgres 16+ and a directory for
git clones. Nothing else: the claim queue is Postgres row locks, live fan-out is Postgres
`LISTEN/NOTIFY`.

The server is **untrusted middleware by design**. Workers verify every signed manifest
themselves, so compromising an instance lets an attacker lie about numbers, not run code on
donors' machines. Host it with ordinary care, not with HSM-grade paranoia.

## Quick start

```sh
git clone <this repo> agentfund && cd agentfund
docker compose up --build
```

Open <http://localhost:8787>. With no `.env` at all you get:

- Postgres 17 in a volume, the app on host port **8787**;
- **dev login** (anyone can log in as any handle; the first one becomes admin) and a loud
  warning in the log, because GitHub OAuth is not configured;
- a webhook secret per project, generated when the project is created.

That is a complete local instance. To make it a real one, copy `.env.example` to `.env`, set at
least `BASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `ADMIN_HANDLES`, and run
`docker compose up -d` again. The port is taken? `HOST_PORT=9000 docker compose up`.

## Configuration

All configuration is environment variables, validated at boot; a bad value stops the server
with a message naming the variable. `.env.example` documents each one line by line.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_NAME` | `AgentFund` | Software name (`meta.app`); change to rebrand a fork |
| `INSTANCE_NAME`, `INSTANCE_DESCRIPTION` | app name / stock line | Seed the instance row on first boot; edited by admins afterwards |
| `BASE_URL` | `http://localhost:<port>` | Public URL; prefix of global ids, OAuth callback, feed/OG links |
| `PORT` | `8787` | Listen port |
| `DATABASE_URL` | compose: bundled Postgres | Postgres 16+; **required** outside compose |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | – | GitHub OAuth app; set both or neither |
| `AUTH_DEV_LOGIN` | `true` iff OAuth is unset | Password-less dev login (capability `dev_login`) |
| `ADMIN_HANDLES` | – (first user is admin) | Comma-separated admin handles |
| `WEB_ORIGINS` | – | Extra origins for token-bearing browser calls and OAuth redirects |
| `WEBHOOK_SECRET` | – (none) | Optional operator-level webhook secret accepted for every project; projects have their own secrets regardless |
| `CI_POLL` | `false` | Poll GitHub for check runs / PR state (capability `ci_poll`) |
| `CI_POLL_INTERVAL_SECONDS` | `30` | Poll period |
| `GITHUB_TOKEN` | – | Raises the poller's GitHub rate limit |
| `DATA_DIR` | `./data` (`/data` in the image) | Bare clones live in `DATA_DIR/repos` |
| `INDEX_INTERVAL_SECONDS` | `60` | Re-index period; `0` disables the timer |
| `ALLOW_FILE_REPOS` | `false` | Accept `file://` repos (tests, local e2e) |
| `WEB_DIST` | `../web/dist` (`/app/web` in the image) | Built SPA to serve |
| `SWEEP_INTERVAL_SECONDS` | `15` | Lease-expiry sweep period |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per IP and per credential on `/v1`; `0` = off |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Per IP on `/v1/auth/*` |
| `TRUST_PROXY` | `false` | Take the client IP from `X-Forwarded-For` |
| `DB_POOL_MAX` | `10` | Postgres connections per process |
| `SOURCE_URL` | `https://github.com/agentfund/agentfund` | `meta.links.source_url`: where this instance's source lives |
| `INSTALL_COMMAND` | the upstream `install.sh` one-liner | `meta.links.install_command`: how donors install the worker |
| `DOCS_URL` | – (omitted) | `meta.links.docs_url` |
| `OG_ACCENT` | `#2563eb` | Accent colour (`#rrggbb`) of generated OG cards |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`; JSON lines on stdout |

Compose-only: `HOST_PORT` (published port), `POSTGRES_PASSWORD`, `AGENTFUND_TAG` (image tag),
`WEB_BUILD` (`auto`/`required`/`skip`, see below).

Leases, trust caps, the per-donor claim limit and open-vs-approval project creation are
**instance settings in the database**, edited by admins in the UI (`/v1/admin/instance`), not
environment variables.

## GitHub login

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Homepage URL: your `BASE_URL`. Authorization callback URL:
   `<BASE_URL>/v1/auth/github/callback`.
3. Put the client id and secret in `.env`, set `ADMIN_HANDLES=<your github login, lowercase>`.

The server asks for `read:user user:email` only and discards the GitHub token as soon as it
has read the profile. Handles are the lower-cased GitHub login. Once OAuth is configured dev
login turns itself off unless you force `AUTH_DEV_LOGIN=true`.

## CI confirmation

Tokens count as *delivered* only when the project's CI passes on the worker's branch, and as
*merged* when the PR merges. The instance learns both in one of two ways.

**Webhook (preferred).** Every project has its own webhook secret, generated when the project
is created. Its maintainer opens the project's maintenance page in the UI
(`GET /v1/projects/<slug>/webhook`, maintainer or admin, session only), which shows the payload
URL, the secret, and the events to subscribe to; "rotate" replaces the secret and the old one
stops working immediately. Then, in the project repository: Settings → Webhooks → Add webhook.

- Payload URL `<BASE_URL>/v1/webhooks/ci`, content type `application/json`;
- Secret: the project's secret from the UI;
- Events: **Workflow runs**, **Check suites**, **Pull requests**, **Pushes**.

`workflow_run`/`check_suite` `completed` → CI result for the head SHA; `pull_request` `closed` →
merged or closed; `push` to the base branch → re-index.

How a delivery is authenticated: the server reads which repository the (still untrusted)
payload names, looks up that project, and verifies the HMAC over the raw body with **that
project's** secret, in constant time. A maintainer therefore cannot sign CI results for anyone
else's project. Unknown repository, wrong secret and missing signature all get the same
`401 bad-signature`.

*Operator option.* If you run one organisation-level webhook for many repositories, set
`WEBHOOK_SECRET` (16+ characters) and use it as that hook's secret: it is accepted for every
project on the instance, in addition to the per-project secrets. It exists only when you set
it, is never shown to maintainers and is not returned by any endpoint. Treat it like an admin
credential.

**Polling.** `CI_POLL=true` makes the instance ask the GitHub REST API itself, for reports that
are still waiting. Use it when GitHub cannot reach the instance (localhost, VPN). It needs no
webhook and no secret at all — the evidence comes straight from GitHub. Set `GITHUB_TOKEN` to
avoid the anonymous rate limit.

**Other CI systems** (`ci_provider: generic` in `agentfund.yaml`) post a `GenericCiResult`
signed with the project's secret (`repo_url` is what selects the project):

```sh
body='{"provider":"generic","repo_url":"https://git.example/me/proj","branch":"agentfund/0001-x-ab12cd34","head_sha":"<40 hex>","conclusion":"success"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$PROJECT_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST "$BASE_URL/v1/webhooks/ci" -H "X-AgentFund-Signature: sha256=$sig" -H 'content-type: application/json' -d "$body"
```

## Behind a reverse proxy

Terminate TLS in front and proxy everything to port 8787. Set `BASE_URL` to the public https
URL and `TRUST_PROXY=true`. `/v1/stream` is Server-Sent Events: the server already sends
`X-Accel-Buffering: no` and a ping every 15 s; make sure the proxy does not buffer or time out
idle responses under ~60 s. Caddy needs nothing special:

```
fund.example.org {
  reverse_proxy app:8787
}
```

Several app replicas can share one Postgres: claims use `FOR UPDATE SKIP LOCKED`, every replica
hears every change through `LISTEN/NOTIFY`, and timers are safe to run concurrently. Give each
replica its own `DATA_DIR` (clones are a cache) and note that rate limits are per process.

## Data, backups, upgrades

- **Postgres is the only state that matters.** Back it up (`pg_dump`). The `events` table is
  append-only and enforced by a trigger: `UPDATE`, `DELETE` and `TRUNCATE` are rejected.
- `DATA_DIR/repos` is a cache of bare clones; delete it and the indexer re-clones.
- The instance's Ed25519 identity (`instances`) and the per-project webhook secrets
  (`projects.webhook_secret`, stored as-is because they are shared HMAC secrets) live in the
  database — a dump contains them, so protect dumps accordingly.
- Upgrades: pull, `docker compose up -d --build`. SQL migrations run automatically at boot,
  under an advisory lock.

## The image

`server/Dockerfile` builds from the **repository root** and produces one image with Node 22,
git and CA certificates, running as the unprivileged `node` user, with a `/healthz` healthcheck:

```sh
docker build -f server/Dockerfile -t ghcr.io/agentfund/agentfund .
docker build -f server/Dockerfile --build-arg WEB_BUILD=required -t … .   # release builds
```

`WEB_BUILD=auto` (default) builds `web/` when it can and otherwise ships the API with a small
placeholder page; `required` fails the build instead; `skip` never builds the UI. The built
SPA is served from `WEB_DIST` with history fallback, and the server injects per-route
`<title>`, description, OpenGraph/Twitter tags, JSON-LD and
`window.__AGENTFUND__ = {apiBase, baseUrl, appName, instanceName, version}` at the
`<!--app-head-->` marker in `index.html` — so one build works on any instance. A UI hosted
elsewhere works too: add its origin to `WEB_ORIGINS`.

## Without Docker

```sh
pnpm install
export DATABASE_URL=postgres://user:pass@localhost:5432/agentfund     # or put it in ./.env
pnpm --filter web build          # optional: the UI
pnpm --filter server build && pnpm --filter server start
```

`pnpm --filter server dev` watches and restarts; `db:migrate` applies migrations without
starting; `seed` (dev login only) creates a user and prints an API key, and registers
`SEED_REPO_URL` as a project when set. The server shells out to `git`, which must be on `PATH`.

## Security notes

- Dev login is a development tool. The server warns on every boot while it is on.
- Session tokens (`afs_…`) and API keys (`af_…`) are stored as SHA-256 hashes only; a key's
  secret is shown once.
- Repository URLs must be `https://` on a public host name — no credentials, no ssh, no
  `ext::`, no private or loopback addresses. Git runs via `execFile` with prompts, hooks,
  system/global config and every other transport disabled, with timeouts. The host check is
  syntactic (it does not resolve DNS); if your instance can reach sensitive internal https
  services, restrict egress at the network level.
- The registered maintainer key of a project never changes except through a valid rotation
  chain in a signed lock. A head commit whose lock does not verify is never indexed: the pin
  stays, `index_error` says why, and the audit log records `project.index_failed`.
- CORS: anonymous GETs are readable from any origin; calls carrying a token only from the
  instance's own origin and `WEB_ORIGINS`.
