# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

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
- `make trial` — tasks of the sample project with a real agent under the backer's own key;
  `TASKS="0001-slugify 0002-truncate 0003-cli"` runs the whole project in order, and
  `TRIAL_KEEP=1` keeps its state and run logs.

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
- **Dependent tasks no longer start from a commit without their dependency.** A task became
  claimable the moment its dependency merged, while the project was still pinned to the commit
  before the merge, so the worker built it on stale code (found by the first real-model run:
  `0002-truncate` re-created the file `0001-slugify` had added). A dependency now counts only
  once the instance has read the base branch, without error, after the merge was recorded. A
  generic CI must send `merged: true` only once the merge is on the base branch.

### Security
- **Claude Code runs with an allowlist of local tools** (`--tools`): shell, file reads and
  edits, search, sub-agents. Its default set includes web search, which the model provider runs
  outside the egress proxy, and tools that create scheduled cloud agents on the backer's
  account.
