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
- `make trial` — one task of the sample project with a real agent under the backer's own key.
