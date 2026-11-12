# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Changed
- A release is published as soon as its tag is built, not left as a draft: `install.sh`
  installs the latest release, and drafts don't count, so v0.1.1 and v0.1.2 were invisible to it
  until published by hand. Tags with a suffix (`-rc1`) are still pre-releases.

## [0.1.2] - 2026-11-12

### Fixed
- `/privacy` and `/terms` are served as real pages (status 200, indexable, with their own
  titles); they were the app shell with status 404 and `noindex`. The server and web
  packages report their release version.

## [0.1.1] - 2026-11-12

### Added
- **Privacy policy and terms of use** at `/privacy` and `/terms`, linked in the footer.
  `LEGAL_NAME` names the operator and `LEGAL_CONTACT` gives the address for data requests;
  `PRIVACY_URL` and `TERMS_URL` point at your own pages instead.
- **Private repositories on members-only instances** — `INSTANCE_ACCESS=members` limits every
  page and API call to signed-in members of `ALLOWED_GITHUB_ORGS`. A read-only GitHub App reads
  private repositories and feeds the CI poller. Backers fetch with their own `gh` login after
  consenting at `approve` (`git_auth: gh`, `--git-auth gh`), and push the task branch straight
  to a private repository they can write to. See
  [Self-hosting](docs/self-hosting.md#members-only-instance-private-repositories).
- `deploy/fly/fly.toml` and a "Deploy to Fly.io" section in the self-hosting guide.
- `CLIENT_IP_HEADER`: take the client IP from a header the edge proxy overwrites
  (`fly-client-ip` on Fly.io), so rate limits can't be dodged with a forged `X-Forwarded-For`.

### Changed
- **Registering a project on a public instance needs push access** to its GitHub repository,
  checked with the maintainer's own GitHub sign-in, so nobody can claim someone else's
  AgentFund-ready project. Admins are exempt and register repositories outside github.com.
  The sign-in token (`read:user user:email`) is now kept sealed on the session, under a key
  derived from the session token; people signed in before this change sign in again to register.
- The default `INSTALL_COMMAND` shown to backers is now the `install.sh` one-liner for the
  released binaries, not a build from source.
- The docs lead with subscription tokens (`claude setup-token`); an API key is still accepted.

## [0.1.0] - 2026-11-10

### Added
- **Spec v1** — task manifest, `agentfund.yaml` and `MANIFEST.lock` JSON Schemas; minisign
  (Ed25519, prehashed) detached lock signature with a key-rotation chain; the five-step worker
  verification chain; OpenAPI 3.1 wire protocol and its normative semantics.
- **Worker CLI** (`agentfund`, Go) — `keygen`, `sign`, `validate`, `login`, `approve`, `work`,
  `dry-run`, `status`, `logs`, `daemon install`; sandboxed execution with an egress allowlist,
  token metering, scope enforcement, fork + PR publishing, and a donor policy engine.
- **Egress proxy** (Rust) — CONNECT-only allowlist sidecar that is the sandbox's only route out.
- **Server** (TypeScript, Hono, Postgres) — v1 API, signature-verifying indexer, lease-based
  claim queue, pledged → reported → delivered → merged ledger, GitHub and generic CI adapters
  (webhook and polling), SSE live totals, OG images, sitemap and Atom feed.
- **Web UI** (React) — discover, project, donor, maintainer, settings and admin pages on the
  public v1 API only; live odometer token counter; dark mode; `/styleguide`.
- **Demo project** — `gridrs`, a std-only terminal spreadsheet in Rust decomposed into signed
  manifests with pre-committed acceptance tests.
- `docker compose up` self-hosting, GoReleaser packaging, install script, CI.
- **Codex runner (experimental)** — `runner.name: codex` drives `codex exec --json` in the
  sandbox with `CODEX_API_KEY`/`OPENAI_API_KEY`; usage is metered at turn end, background
  features are switched off, and a run stuck waiting for an unreachable API is stopped.
  `runner.token_command` for any runner. The sandbox image ships Codex next to Claude Code.
- **Codex with ChatGPT credentials (experimental)** — a Business/Enterprise access token in
  `CODEX_ACCESS_TOKEN`, or a ChatGPT sign-in used only by AgentFund (`runner.codex_home`,
  `CODEX_HOME=<dir> npx -y @openai/codex@0.167.0 login`) that the worker refreshes on the host before each run; the
  sandbox gets the access token without the refresh token. The egress allowlist follows the
  credential (`chatgpt.com` instead of `api.openai.com`). Design:
  `docs/dev/codex-chatgpt-signin.md`.
- `make trial` — tasks of the sample project with a real agent under the backer's own key;
  `TASKS="0001-slugify 0002-truncate 0003-cli"` runs the whole project in order, and
  `TRIAL_KEEP=1` keeps its state and run logs.
- `sandbox.extra_ca_certs` — a PEM file of extra CA certificates (a TLS-inspecting corporate
  proxy's, say) that the agent trusts inside the sandbox. Validated at config load (readable,
  certificates only, no private key), copied into a root-owned tmpfs at sandbox start and
  exported as `NODE_EXTRA_CA_CERTS` (Claude Code) and `SSL_CERT_FILE` (a combined bundle with
  the image's roots, for Codex and OpenSSL tools).

### Changed
- A released `agentfund` defaults to the sandbox and egress-proxy images published with it, by
  digest (`agentfund version` names them); a build from source keeps the local `:dev` images. A
  saved `config.yaml` stores `""` for the default images, so upgrading the binary upgrades them.
  A config saved by an earlier build names `agentfund/sandbox:dev` and
  `agentfund/egress-proxy:dev` outright and keeps them: set both to `""` to follow the binary.
  Release candidates no longer move the `latest` image tag.
- The project's home is `github.com/ghvstcode/agentfund` (was the placeholder
  `agentfund/agentfund`): Go module path, install script, release config, server and web
  defaults, compose file and docs.

### Fixed
- The sample project's CI (`examples/hello-project`) no longer fails on a fresh copy that has
  no tests yet: `unittest` exits 5 when it finds none, which is now treated as a pass.
- **Dependent tasks no longer start from a commit without their dependency.** A task became
  claimable the moment its dependency merged, while the project was still pinned to the commit
  before the merge, so the worker built it on stale code (found by the first real-model run:
  `0002-truncate` re-created the file `0001-slugify` had added). A dependency now counts only
  once the instance has read the base branch, without error, after the merge was recorded. A
  generic CI must send `merged: true` only once the merge is on the base branch.
- **An agent that never reaches the model API releases the claim instead of failing it.** No
  network, DNS or a proxy in the way is the backer's problem, not the task's, but it was
  reported as `failed`, which put a failure on the ledger and locked the backer out of the task
  for 24 h. Both runners now recognise "the API never answered" (Claude Code: connection retries
  without an HTTP status, recorded live with 2.1.289; Codex: stuck "waiting for network"); the
  worker releases the claim and backs off as for a rate limit. A failure after the API has
  answered is still a failure.

### Security
- **Claude Code runs with an allowlist of local tools** (`--tools`): shell, file reads and
  edits, search, sub-agents. Its default set includes web search, which the model provider runs
  outside the egress proxy, and tools that create scheduled cloud agents on the backer's
  account.

[Unreleased]: https://github.com/ghvstcode/agentfund/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/ghvstcode/agentfund/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ghvstcode/agentfund/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ghvstcode/agentfund/releases/tag/v0.1.0
