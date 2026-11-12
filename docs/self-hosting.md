# Self-hosting an AgentFund instance

An AgentFund instance is one container and one Postgres database. You can run one for your
own community, or privately inside your company so engineers' spare agent quota goes to the
open source you depend on. [For organisations](for-organizations.md) explains how the settings
map onto a company and what v0.1 can't do yet. This page is how to run one.

New here? `make demo` runs a throwaway instance with a sample project and a worker in one
command ([Quickstart](quickstart.md)). [Concepts](concepts.md) explains what the server is and
isn't trusted with.

## What you're running

One container serves the API (`/v1`), the live stream, the web UI and the discovery routes
(`/sitemap.xml`, `/feed.atom`, `/og/<slug>.png`). It needs Postgres 16+ and a directory for
git clones, and nothing else. The claim queue uses Postgres row locks, and live fan-out uses
Postgres `LISTEN/NOTIFY`. Released images are published as `ghcr.io/ghvstcode/agentfund`, and
`docker-compose.yml` uses that image.

The server is **untrusted middleware by design**. Workers verify every signed manifest
themselves, so someone who compromises an instance can lie about numbers but can't run code
on donors' machines. Agents run only on donors' machines, in a sandbox whose only way out, by
default, is the model API. The server never sees a model or git credential. Host it with ordinary care,
not with HSM-grade paranoia.

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
| `GITHUB_TOKEN` | – | Raises the poller's GitHub rate limit for public repositories |
| `INSTANCE_ACCESS` | `public` | `members`: every page and API call needs a signed-in member; see [Members-only instance](#members-only-instance-private-repositories) |
| `ALLOWED_GITHUB_ORGS` | – | GitHub organizations whose members may sign in (`members` only) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_FILE` | – | Read-only GitHub App that reads private repositories and checks membership; allowed only with `INSTANCE_ACCESS=members` |
| `DATA_DIR` | `./data` (`/data` in the image) | Bare clones live in `DATA_DIR/repos` |
| `INDEX_INTERVAL_SECONDS` | `60` | Re-index period; `0` disables the timer |
| `ALLOW_FILE_REPOS` | `false` | Accept `file://` repos (tests, local e2e) |
| `WEB_DIST` | `../web/dist` (`/app/web` in the image) | Built SPA to serve |
| `SWEEP_INTERVAL_SECONDS` | `15` | Lease-expiry sweep period |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per IP and per credential on `/v1`; `0` = off |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Per IP on `/v1/auth/*` |
| `CLIENT_IP_HEADER` | – | Header the edge proxy sets to the client IP, overwriting any client value (`fly-client-ip` on Fly.io); takes precedence over `TRUST_PROXY` |
| `TRUST_PROXY` | `false` | Take the client IP from `X-Forwarded-For` |
| `DB_POOL_MAX` | `10` | Postgres connections per process |
| `SOURCE_URL` | `https://github.com/ghvstcode/agentfund` | `meta.links.source_url`: where this instance's source lives |
| `INSTALL_COMMAND` | the `install.sh` one-liner (see `.env.example`) | `meta.links.install_command`: how donors install the worker |
| `DOCS_URL` | – (omitted) | `meta.links.docs_url` |
| `PRIVACY_URL`, `TERMS_URL` | – (built-in pages) | `meta.links.privacy_url` / `terms_url`: your own policy pages. Without them the UI serves `/privacy` and `/terms`, a template that fills in `LEGAL_NAME` and `LEGAL_CONTACT` but leaves your hosting providers and governing law as visible `[placeholders]`, so a public instance should publish its own |
| `LEGAL_CONTACT` | – | `meta.links.legal_contact`: the email address the built-in pages give for data, deletion and terms requests |
| `LEGAL_NAME` | – | `meta.links.legal_name`: who runs the instance, a person or a company, as the built-in pages name the operator |
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

The server asks for `read:user user:email` only. It keeps the GitHub token on the session,
sealed (AES-256-GCM) under a key derived from the session token, which the database holds only
as a hash; the token dies with the session. Registering a project uses it to ask GitHub whether
the maintainer can push to the repository (admins skip the check). Sessions from before that
change have no token: those users sign in again to register. Handles are the lower-cased GitHub login. Once OAuth is configured dev
login turns itself off unless you force `AUTH_DEV_LOGIN=true`.

## Members-only instance (private repositories)

With `INSTANCE_ACCESS=members` the instance is for the members of your GitHub organization
only, and its projects may live in private repositories. The two come together on purpose:
an instance that can read private repositories never shows anything to anonymous visitors.

1. **Create a GitHub App** owned by the organization (Settings → Developer settings → GitHub
   Apps). It needs no webhook and no callback. Give it read-only permissions and nothing else:
   - Repository: **Contents**, **Metadata**, **Checks** and **Pull requests**, read.
   - Organization: **Members**, read.

   Generate a private key, then install the app on the organization. Choose **only selected
   repositories**: the ones you will register on the instance.
2. **Configure the server**:

   ```bash
   INSTANCE_ACCESS=members
   ALLOWED_GITHUB_ORGS=acme
   GITHUB_APP_ID=Iv23...            # the app's client ID (or its numeric app ID)
   GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem
   GITHUB_CLIENT_ID=...             # GitHub OAuth, as above
   GITHUB_CLIENT_SECRET=...
   AUTH_DEV_LOGIN=false
   CI_POLL=true                     # optional, see below
   ```

   The server refuses to start if any of these is missing, if dev login is on, or if a GitHub
   App is configured on a public instance.

What changes:

- **Every API operation needs a member's session or worker key**, except `GET /v1/meta`, GitHub
  sign-in and the signed CI webhook. Sign-in refuses anyone who is not a member of an allowed
  organization. Membership is re-checked through the app at most every 15 minutes, so someone
  who leaves the organization loses access within that window. Banning them in the admin UI
  takes effect at once.
- **Pages carry no project data.** Every path gets the same unindexed shell, which then asks
  the visitor to sign in. `/sitemap.xml`, `/feed.atom` and `/og/*.png` answer 404, and
  `robots.txt` disallows everything. Live updates use polling instead of server-sent events,
  because a browser cannot send the token with `EventSource`.
- **The server reads repositories with the app.** For each fetch it mints a one-hour token
  narrowed to that one repository and to read access. The token stays in memory and reaches
  git through the environment, never on a command line. A repository the app is not installed
  on is fetched anonymously, as before.
- **Registering a project needs write access.** Preview and create check, through the app,
  that the signed-in member can write to the repository. They do this before anything is
  fetched, and every failure reads the same, so preview cannot be used to read a private
  repository or to learn that it exists.
- **The CI poller uses the app's token** for the project's repository; webhooks work as before.
- **Every member sees every project** on the instance: tasks, prompts, numbers and the feed. If
  some repositories must stay hidden from some members, run a separate instance for them.

Backers fetch and push private repositories with their own `gh` login, on their own machine.
The server never hands out a git credential. See [Private projects](donors.md#private-projects)
in the donor guide.

GitHub's documentation does not say which app permission the membership and collaborator
endpoints need. If sign-in refuses members, or registering refuses maintainers, check that
the app has **Members: read** on the organization and **Metadata: read** on the repositories.
Both checks fail closed.

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
URL and tell the server where the client IP is: `CLIENT_IP_HEADER` when the proxy sets a header
it overwrites (Fly's `fly-client-ip`, nginx's `X-Real-IP` if you set it), otherwise
`TRUST_PROXY=true`, which takes the first `X-Forwarded-For` entry and is only safe when the proxy
replaces that header rather than appending to it. `/v1/stream` is Server-Sent Events: the server already sends
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

## Deploy to Fly.io

[`deploy/fly/fly.toml`](../deploy/fly/fly.toml) runs the published image on one Fly machine
that never stops (the server holds a `LISTEN` connection, runs timers and answers webhooks).
It needs no volume: `DATA_DIR` holds only the clone cache. Postgres lives elsewhere.

1. **Postgres.** Either Fly's managed Postgres (`fly mpg create`, backups included), or a
   hosted provider such as Neon or Supabase. With a hosted provider use the **direct**
   connection string, not the pooled one: a transaction-mode pooler (PgBouncer) breaks
   `LISTEN/NOTIFY`, and the live updates with it.
2. **The app.** Edit `app` and `primary_region` in `fly.toml`, then:

   ```sh
   fly apps create <app>
   fly secrets set -a <app> \
     DATABASE_URL='postgres://…' \
     BASE_URL=https://fund.example.org \
     GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… \
     ADMIN_HANDLES=<your github login>
   fly deploy -c deploy/fly/fly.toml --ha=false
   ```

   Create the GitHub OAuth app first ([GitHub login](#github-login)) with the callback
   `https://fund.example.org/v1/auth/github/callback`. Migrations run at boot.
3. **The domain.** `fly certs add -a <app> fund.example.org` prints the DNS records; add them at
   your DNS provider. On Cloudflare, leave the record **DNS only** (grey cloud) so Fly
   terminates TLS and `fly-client-ip` is the visitor's address. Behind Cloudflare's proxy it
   would be a Cloudflare edge address and every visitor would share one rate limit.
4. **Check it.** `curl https://fund.example.org/healthz`, sign in with GitHub, and confirm
   `/v1/meta` shows `dev_login` off.

Upgrades: change the image tag in `fly.toml` and `fly deploy` again. Keep one machine: rate
limits are per process, and nothing needs more yet.

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
docker build -f server/Dockerfile -t ghcr.io/ghvstcode/agentfund .
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
  `ext::`, no private or loopback host names. Git runs via `execFile` with prompts, hooks,
  system/global config and every other transport disabled, with timeouts. The host check is
  syntactic (it does not resolve DNS); if your instance can reach sensitive internal https
  services, restrict egress at the network level.
- The registered maintainer key of a project never changes except through a valid rotation
  chain in a signed lock. A head commit whose lock does not verify is never indexed: the pin
  stays, `index_error` says why, and the audit log records `project.index_failed`.
- CORS: anonymous GETs are readable from any origin; calls carrying a token only from the
  instance's own origin and `WEB_ORIGINS`.
