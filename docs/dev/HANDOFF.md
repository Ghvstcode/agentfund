# Handoff: from "built" to "released"

Written 2026-11-08 at the end of a cloud session, for the agent that takes over on the
maintainer's own machine. Read all of it before changing anything. It is the plan, the context
behind the plan, and the rules for working on it.

You own the outcome: drive the work in [Phase A](#phase-a-developer-preview-v010), then
[Phase B](#phase-b-public-launch), then [Phase C](#phase-c-product-work-including-trending-projects),
fixing whatever you find along the way. The [human decisions](#decisions-only-the-human-can-make)
are the exception: you prepare them, you do not make them.

---

## 1. Where the project stands

**AgentFund** is "Kickstarter for LLMs". A maintainer splits an open-source project into small
signed tasks. A backer runs the `agentfund` worker, which checks the signature, runs each task's
coding agent in a Docker sandbox under the backer's own model credentials and budget caps,
pushes a branch and opens a PR. A server keeps a public ledger, and tokens count as
*delivered* only once CI passes on that PR. No money moves. Start with the [README](../../README.md)
and [concepts](../concepts.md).

| Part | Path | Stack |
| --- | --- | --- |
| Contract: manifest, lock, signature, wire protocol | [`spec/`](../../spec/) | JSON Schema, OpenAPI 3.1 |
| Worker CLI for backers and maintainers | [`worker/`](../../worker/) | Go 1.27 (toolchain auto-downloads) |
| Sandbox images | [`images/sandbox/`](../../images/sandbox/) | Docker: real image and mock-agent `e2e` images |
| Egress proxy (the sandbox's only route out) | [`images/egress-proxy/`](../../images/egress-proxy/) | Rust |
| Server: API, indexer, claim queue, ledger, CI adapters | [`server/`](../../server/) | TypeScript, Hono, Postgres, Drizzle |
| Web UI (uses only the public API) | [`web/`](../../web/) | React, shadcn/ui, Tailwind v4 |
| Sample projects | [`examples/`](../../examples/) | `hello-project` (Python, 3 tasks); gridrs is described in the README |

**The code is in good shape**: tests in every package, CI green on `main`, candid docs (see
[SECURITY.md](../SECURITY.md) "Honest limitations"). **What it lacks is contact with reality**:
every path that matters to a real user has run against a mock agent, or at most once by hand.
The README's [Status table](../../README.md#status) is the source of truth for what is proven.
Update it every time something gets proven.

### Proven, not proven

| | State |
| --- | --- |
| Full loop with the mock agent (claim, verify, sandbox, branch, CI, delivered, merged) | Proven, in CI on every push (`scripts/e2e.sh`) |
| Real GitHub path (push, PR via `gh`, Actions, delivery by polling, merge), mock agent, backer owns the repo | Proven once, by hand |
| Real Claude Code CLI in the real sandbox, through the egress proxy, up to the model API | **Proven 2026-11-08** (fake key refused; claim released cleanly; worker stopped). See §2 |
| A real model completing a task | **Proven 2026-11-10** for all three `hello-project` tasks (Claude Code, Sonnet). A gridrs task is still open in A1 |
| Codex runner | Added 2026-11-08, **experimental**, never run against the real API. This is A2 |
| PR from a fork (backer does not own the repo) | **Not exercised.** This is how every real donation works. This is A3 |
| CI results by live GitHub webhook | **Proven 2026-11-10** (A4) |
| Release workflow, published images, `install.sh` against a real release | **Never run.** This is A6 |
| `max_concurrent` > 1 | Not exercised. Keep the default at 1 and say so |
| GitHub OAuth login | Unit-tested with a mocked GitHub; never used live. Part of B1 |

---

## 2. What the cloud session did (2026-11-08)

Commit `e01a6ce` on branch `claude/vibrant-fermat-ig3cvg`, **not merged to `main` yet**. Open a PR
or merge it first (ask the human which they prefer), then branch from `main` for new work.

1. **Ran the real worker against a local instance with the real Claude Code CLI (2.1.289) in the
   sandbox.** Approve, dry-run, claim, signature and hash checks, sandbox, scope and egress
   allowlist all behaved. The request reached `api.anthropic.com`; the fake key was refused; the
   worker classified it as a credential problem, **released** the claim (did not fail the task)
   and stopped. The container could not hold a real Anthropic key, so the run stopped there.
2. **Added the Codex runner** (`runner.name: codex`), checked against the real `codex-cli`
   0.167.0: [`worker/internal/runner/codex.go`](../../worker/internal/runner/codex.go), tests,
   and [`CODEX_NOTES.md`](../../worker/internal/runner/CODEX_NOTES.md), which marks verified and
   unverified items. Key facts:
   - usage arrives only at `turn.completed`, so `max_tokens` is checked after the fact (a run can
     overshoot; it is recorded as having hit its cap);
   - with no route to the API, Codex retries "waiting for network" **forever**. The runner now
     stops it after 4 such messages in a row (about 60 s instead of the 20-minute timeout);
   - even with an API key it calls `chatgpt.com`, `ab.chatgpt.com` and GitHub. The proxy refuses
     them; `--disable` flags and `-c analytics.enabled=false` removed the GitHub and `ab.` calls,
     plain `chatgpt.com` remains;
   - API keys only (`CODEX_API_KEY` / `OPENAI_API_KEY`); ChatGPT sign-in is a file, not supported.
3. **`runner.token_command`** for any runner (`claude_token_command` still works for Claude Code).
4. **Sandbox image** installs Codex 0.167.0 next to Claude Code.
5. **`make trial`** ([`scripts/trial.sh`](../../scripts/trial.sh)): local instance, signed sample
   project, one task with the **real** agent under your key, then plays CI and merges if `verify`
   passes. Tested here only up to the refused fake key, for both runners.
6. **[docs/runners.md](../runners.md)**: supported agents, the Codex caveats, what another agent
   needs, and candidates (Gemini CLI, Cursor CLI, opencode, Copilot CLI, Amp, Goose, Aider). The
   candidate details are **unverified**.

### Findings from that run that are not fixed yet

- ~~**TLS-inspecting networks break the sandbox.**~~ Fixed by `sandbox.extra_ca_certs` (A7).
  Networks that allow only an explicit upstream proxy still fail: the egress sidecar dials out
  directly.
- ~~**"API unreachable" counts as a task failure**~~ (both runners). Fixed 2026-11-10: the
  claim is released and the worker backs off. See A7.
- Two things that are working as designed but will trip you while testing:
  - `--budget` below a task's `max_tokens` refuses the task, because the whole `max_tokens` is
    reserved up front. `hello-project` tasks are 1M, so use `--budget 1M`.
  - After a failed attempt the worker will not claim that task again for 24 h. For testing, set
    `retry_failed_after: "0"` in the worker's `config.yaml` (`make trial` does this).

---

## 3. How to work

- **Verify, don't assume.** This project's docs separate "verified by execution" from "not
  verified". Keep that discipline: when you prove something, update the README Status table, the
  relevant `*_NOTES.md` and the [CHANGELOG](../../CHANGELOG.md); when you can't, say so.
- **Run the checks before every commit** for what you touched:
  - `make check`: spec schemas, OpenAPI lint, Markdown links and anchors, every `agentfund
    <cmd> --flag` and `make <target>` the docs mention;
  - `cd worker && gofmt -l . && go vet ./... && go test ./...`;
  - `pnpm --filter server lint && pnpm --filter server test` (needs Docker: Testcontainers);
  - `pnpm --filter web lint && pnpm --filter web test`;
  - `make e2e` for anything on the claim → report path;
  - `cd worker && go test -tags integration -count=1 ./...` (needs the e2e images:
    `make -C worker e2e-images`).
- **The spec is the contract.** An API change starts in `spec/openapi.yaml`, then
  `pnpm --filter server generate` and `pnpm --filter web gen:api`; `pnpm --filter web check:api`
  and `server/test/contract.test.ts` catch drift. Manifest and config schemas live in
  `spec/schemas/`; `make -C worker sync-spec` copies them into the worker.
- **Commits**: Conventional Commits (`feat(worker): …`, `fix(server): …`, `docs: …`), one concern
  per commit, body explaining why. Work on a branch; open PRs; don't push to `main` without the
  human's say-so.
- **Never** skip or weaken a test to get green, commit a credential, or spend more than a few
  dollars of the human's tokens without asking first. Every real-model run: `--once`, the smallest
  `--budget` that fits, a cheap model (`MODEL=sonnet`), and read `agentfund logs` afterwards.
- **Run logs** are JSONL: `agentfund logs` lists them, `agentfund logs <claim>` shows one. The
  `egress` records show every host the agent tried, allowed or denied, which is the fastest way to
  see what an agent CLI really does.

---

## Phase A: developer preview (v0.1.0)

Goal: a tagged release people can install and self-host, with every limitation written down.
Order matters: A1 and A3 will surface bugs that change everything after them.

### A1. First real-model run with Claude Code

```sh
MODEL=sonnet ANTHROPIC_API_KEY=… make trial      # or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
```

The first run builds the full sandbox image (Go and Rust toolchains, several minutes). Then:

1. Read the whole run log. Check: tokens metered and plausible; the agent wrote only inside
   `scope.write`; `verify` ran in the sandbox and passed; the branch has the agent's commit;
   the report reached the server with the right runner/model/version; after `make trial` played
   CI the totals moved reported → delivered → merged, and the project page shows it.
2. Run the other two `hello-project` tasks. 0002 depends on 0001, and 0003 on both, so a task
   only becomes claimable after the previous one is merged: run them in order on one instance.
   `make trial` runs a single task and tears down on Ctrl-C, so extend it (e.g. a `TASKS` list)
   or drive the worker by hand against a `make demo-manual`-style instance.
3. Then a realistic project: a gridrs task (Rust; the README describes it), which exercises a
   bigger repository, a toolchain and a longer run. Watch `timeout_minutes`, memory, PIDs.
4. Expect failures. Likely areas: the read-only root file system (agents and toolchains wanting
   to write caches), the scope check rejecting files the agent legitimately touched, prompt
   handling, and the meter's numbers compared with the Anthropic console. Fix them at the root,
   add a regression test (a recorded stream under `worker/internal/runner/testdata/` is the
   pattern, see `real-2.1.289-simple.jsonl`), and update `CLAUDE_CODE_NOTES.md`.

**Done when** a real model has completed all three `hello-project` tasks and one gridrs task,
end to end, and the README row "A real model inside the sandbox" says **Proven** with the date.

### A2. Codex for real

```sh
RUNNER=codex OPENAI_API_KEY=… make trial
```

Go through every *not verified by execution* item in
[CODEX_NOTES.md](../../worker/internal/runner/CODEX_NOTES.md): the `turn.completed` usage shape
and whether `input_tokens` really includes the cached part; `turn.failed`; how a bad key, no
quota and a rate limit actually look (try a bad key on purpose, and fix the regexes in
`codex.go` to match what really comes out); whether the `chatgpt.com` calls matter once the model
answers. Record a real stream as a fixture. Decide with the human whether Codex stays
experimental for v0.1 (it is fine if it does; the overshoot of `max_tokens` is the reason).

**Done when** the notes have no unverified item that matters, and there are tests built from
real recorded streams.

### A3. The fork path on real GitHub

Every real donation comes from a backer who does **not** own the repository: the worker forks,
pushes to the fork, opens a cross-repository PR. Never exercised. Set up a throwaway public
repository under one GitHub account (the maintainer: signs the tasks, registers the project) and a
**second** account as the backer (`gh auth login` as that account). Run one task end to end, CI on
GitHub Actions, delivery confirmation, merge, re-pin. Read
[maintainers.md](../maintainers.md) on hardening CI for fork PRs and check that the docs match
what you had to do.

**Done when** the README row "Pull request from a fork" says **Proven**, and the maintainer and
donor guides describe what you actually did.

### A4. CI confirmation by live webhook

Webhooks from GitHub have only been tested with recorded fixtures; live delivery was confirmed by
polling (`CI_POLL=true`). With the instance reachable from GitHub (a tunnel such as
`cloudflared` or `ngrok` is fine), configure the per-project webhook the UI shows and confirm a
real `check_suite`/`pull_request` delivery moves a report to delivered and merged. If it
cannot be made reliable for v0.1, make polling the documented default instead and say so.

**Done 2026-11-10.** A public throwaway repository on the maintainer's account (the server
indexes public repositories only, by design), a local instance behind a `cloudflared` quick
tunnel, the webhook added exactly as the Maintain page shows it, and one task by the worker with
the mock agent (no model tokens): GitHub's `ping`, `check_suite` and `workflow_run` deliveries
moved the report to delivered within seconds of CI passing, merging the PR moved it to merged,
and the `push` re-pinned the project to the merge commit, which made the dependent task
claimable. The backer owned the repository, so this pushed to it directly: the fork path is
still A3. Found: the sample project's CI failed on `main` before any task had merged
(`unittest` exits 5 with no tests); fixed.

### A5. The project's GitHub home

**Done 2026-11-10** (human's choice: rename to the real home). Every reference to the old
placeholder `github.com/agentfund/agentfund` now points at `ghvstcode/agentfund`: the Go module
path, GoReleaser, `install.sh`, the server and web defaults, `docker-compose.yml`, the issue
template config and the docs; gridrs links point at `github.com/Ghvstcode/gridrs`. Lower case
throughout, because GHCR image names and Go module paths must be. Left as they are: the
`agentfund.dev` JSON Schema `$id`s (identifiers, never fetched) and the local `agentfund/...`
image tags. Both repositories are **private**: the install script, `go install` and the
release downloads only work for the public once they are public (a launch decision).

### A6. Release rehearsal

The release workflow ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)) has
never run. It builds the worker with GoReleaser (draft release) and pushes three multi-arch images
to GHCR: `agentfund` (server + UI), `agentfund-sandbox`, `agentfund-egress-proxy`.

1. `goreleaser check` and `goreleaser build --snapshot --clean` locally.
2. Tag `v0.1.0-rc1` (with the human's go-ahead) and watch the workflow. The amd64 + arm64 sandbox
   image (Go and Rust under QEMU) is the step most likely to fail or time out.
3. Point the defaults at the published images: `config.DefaultSandboxImage` /
   `DefaultEgressProxyImage` in `worker/internal/config/config.go` are still `:dev` names, and the
   docs tell people to pin by digest; make that concrete.
   **Done 2026-11-10:** the release workflow builds the images first and GoReleaser stamps their
   digests into the binary (`-X …/config.DefaultSandboxImage=…@sha256:…`); a saved config stores
   `""` for them so an upgrade brings the new images; `agentfund version` names them; a missing
   pinned image gets a `docker pull` hint. Step 1 also passed locally (`goreleaser check`, a
   snapshot release of all four archives). Not yet run on GitHub: the workflow itself (step 2).

   Traps for step 2 and step 4 with an rc tag:
   - An rc tag gets only its own image tag (`0.1.0-rc1`; metadata-action drops the `v`), never
     `latest`, so `docker compose up` needs `AGENTFUND_TAG=0.1.0-rc1`.
   - GoReleaser publishes a draft, and GitHub's "latest release" skips drafts and pre-releases:
     install the rc with `AGENTFUND_VERSION=0.1.0-rc1 sh scripts/install.sh` (after publishing the
     draft as a pre-release).
   - The repository is private, and so are GHCR packages pushed from it. Each package's
     visibility is set on its own settings page. Until both repository and packages are public,
     nobody else can install the binary or pull the images it defaults to.
4. On a clean macOS machine and a clean Linux machine: `install.sh` → `agentfund --version` →
   `docker compose up` from the published server image → the quickstart, as a newcomer would.
5. Fix, tag `v0.1.0`, publish the draft release, update the README Status section.

### A7. Small fixes found on 2026-11-08

- **Custom CA for the sandbox** (done 2026-11-10): `sandbox.extra_ca_certs` (path to a PEM
  bundle), validated at load, exported as `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`, with config
  docs and tests. It is copied into the sandbox rather than bind-mounted, because Colima cannot
  see most host paths. `SSL_CERT_FILE` is a combined bundle, because Codex's WebSocket client
  uses it in place of its roots.
- ~~**Unreachable API should release, not fail.**~~ Done 2026-11-10 (`Outcome.NetworkProblem`,
  see the progress log). When the agent never reached the model API (Codex
  `Unreachable()`, Claude Code "Unable to connect to API"), release the claim with a clear reason
  and back off, as for a rate limit, instead of `failed` plus the 24 h lockout. Probably a new
  `Outcome` field (e.g. `NetworkProblem`) handled in `worker/internal/pipeline/run.go` next to
  `CredentialProblem` and `RateLimited`.
- ~~**`SECURITY.md` names no real contact address.**~~ Done 2026-11-10: mail@tobiokewole.com.

### Phase A exit criteria

A1–A7 done; README Status table updated with dates; CHANGELOG has a `0.1.0` section; the known
limitations (Codex experimental if so, no SNI pinning, `max_concurrent` 1, no federation,
Docker-not-a-VM) are stated in the README and release notes.

---

## Phase B: public launch

Goal: people can visit a site, sign in and back a project. Mostly operations, people and
policy, not code. Each item needs the human for accounts, money or judgement.

- **B1. A production instance.** Domain, TLS, GitHub OAuth app, `AUTH_DEV_LOGIN=false`,
  `TRUST_PROXY` behind the reverse proxy, Postgres backups (`pg_dump`, tested restore), log and
  uptime monitoring, upgrade procedure. Follow and correct [self-hosting.md](../self-hosting.md).
  Log in with GitHub for real (never done live). Exercise the admin moderation (pause or remove a
  project) once.
- **B2. A real first campaign.** gridrs ("funded in public", the README roadmap) plus at least one
  maintainer who is not the project's author, and a handful of friendly backers through several
  full cycles. The question it answers: can maintainers decompose work into tasks a model
  finishes and CI can judge? Feed what you learn into [maintainers.md](../maintainers.md) and
  `agentfund validate` / lint.
- **B3. The subscription-terms question.** The docs say the backer's plan terms are the backer's
  business, and that an API key is the unambiguous option (README, FAQ, SECURITY.md item 3). If
  donating through a Pro/Max subscription is outside Anthropic's terms, it is the backers' accounts
  that are at risk. Recommendation to the human: lead with API keys at launch, and consider asking
  Anthropic directly before promoting subscription use. Do not make legal claims in the docs.
- **B4. An outside security review** of the sandbox and egress proxy: the promise that a backer's
  machine stays safe running a stranger's tasks. Prepare a short brief from SECURITY.md's threat
  model; consider doing the SNI-pinning hardening (C4) first.
- **B5. Privacy policy and terms pages** for the hosted instance (it stores GitHub identities and
  email addresses), linked from the UI footer. Templates are fine; the human approves the text.

---

## Phase C: product work, including trending projects

### C1. Trending projects on the landing page (requested by the human)

The human wants the landing page to show interesting, trending projects. What exists today:

- The landing page **is** the Discover page ([`web/src/pages/Discover.tsx`](../../web/src/pages/Discover.tsx),
  route `index`). It lists projects with a sort select whose default is **Trending**, and a note
  saying "Trending ranks by tokens delivered in the last 7 days".
- The server ranks with `velocity_7d DESC, delivered DESC, created_at DESC`
  ([`server/src/services/projects.ts`](../../server/src/services/projects.ts), the `trending` sort;
  `velocity_7d` is computed from `reports.delivered_at`).

What is missing, and a proposed shape (confirm the design with the human before building):

1. **A highlighted "Trending this week" section** at the top of the landing page, above the full
   list: 3–6 cards with the 7-day velocity, each linking to the project page. Reuse what exists:
   [`ProjectCard.tsx`](../../web/src/components/ProjectCard.tsx) already renders a
   [`Sparkline`](../../web/src/components/Sparkline.tsx); check `/styleguide` for the visual
   language.
2. **A cold-start answer.** On a new instance nothing has been delivered, so "trending" is just
   "newest". Options: blend recent activity that is not delivered yet (claims and reported tokens,
   weighted lower), backer count growth, and pledges; or fall back to an operator-curated list
   until real velocity exists. Delivered tokens must stay the only thing that *ranks* a leaderboard
   (README "What stops fake numbers?"), so keep any unverified signal out of rankings that claim
   to be about delivery, and label the section honestly.
3. **Featured projects (optional):** an admin-set `featured` flag. That is a spec change
   (`spec/openapi.yaml`: project field + admin update), a Drizzle migration, server, generated
   types, admin UI and an audit event like the existing moderation events.
4. Tests: server ordering tests (cold start, ties, paused and removed projects excluded), web
   tests for the section, the mock API in `web/dev/` updated so `make dev` shows it, and the
   overflow sweep (`pnpm --filter web overflow`) from 390 to 1440 px.

### C2. More coding agents

Following [runners.md](../runners.md): verify each candidate CLI for real (headless mode, prompt
on stdin, JSON events with token usage, ideally while running, approvals off, credentials from the
environment, a short host list), then implement the best one or two, Gemini CLI first. Each needs
a `*_NOTES.md` and recorded-stream tests like Codex.

### C3. More than one task at a time

`max_concurrent` > 1 has never been exercised: run it, fix what breaks (store locking,
reservation accounting against daily caps, log interleaving), or cap it at 1 in validation.

### C4. Egress proxy: TLS server-name pinning

SECURITY.md item 2: the proxy pins the resolved IP but does not check the TLS SNI inside the
tunnel, so domain fronting through a shared CDN edge is not ruled out. Peek at the ClientHello
in the CONNECT tunnel and reject a server name that does not match the CONNECT host.

### C5. Federation (roadmap, not v0.1)

See [decisions.md](../decisions.md#federation-what-was-decided-now-so-it-stays-possible-later).
Don't start without the human.

---

## Decisions only the human can make

Prepare each with options and a recommendation, then ask:

1. Merge `claude/vibrant-fermat-ig3cvg` into `main` directly, or through a PR? (§2)
2. ~~The project's GitHub home (A5)~~: renamed to `ghvstcode/agentfund`, 2026-11-10.
3. Spending: model credits for A1/A2 (a few dollars), a second GitHub account for A3.
4. When to tag `v0.1.0-rc1` and `v0.1.0`. (A6)
5. Does Codex ship as experimental or stay hidden in v0.1? (A2)
6. ~~Security contact address (A7)~~: mail@tobiokewole.com, 2026-11-10.
7. Hosting, domain and on-call for the public instance. (B1)
8. The subscription-terms stance and whether to contact Anthropic. (B3)
9. The trending/featured design. (C1)

## Progress log

Append one line per milestone, newest last: date, what was proven or shipped, commit or PR.

- 2026-11-08: real Claude Code CLI ran in the sandbox up to the model API; Codex runner
  (experimental), `make trial`, runners guide. `e01a6ce`.
- 2026-11-10: `claude/vibrant-fermat-ig3cvg` fast-forwarded into `main` (human's choice: direct).
- 2026-11-10: A1 in part. A real model (Claude Code 2.1.289, Sonnet, `setup-token` OAuth token)
  completed all three `hello-project` tasks end to end. Found and fixed: dependents were
  claimable before the pin contained the merge (server gate, tests); Claude Code had web search
  and cloud-scheduling tools (now a `--tools` allowlist). `make trial` runs a `TASKS` list.
  Left in A1: a gridrs task. PR #1.
- 2026-11-10: A5 done: renamed from the placeholder `agentfund/agentfund` to `ghvstcode/agentfund`.
- 2026-11-10: A6 prep: released binaries default to their images by digest; `goreleaser check` and a
  local snapshot release pass; rc tags no longer move `latest`. Security contact set (A7). A3
  deferred: no second GitHub account yet (human's call).
- 2026-11-10: A4 done: live GitHub webhooks (through a tunnel) moved a report to delivered and merged,
  and re-pinned. Sample CI fixed for a repository with no tests yet.
- 2026-11-10: A7 "unreachable API" done. `Outcome.NetworkProblem` from both meters; the worker
  releases the claim and backs off (shared with rate limits, `BackoffState.Cause`) instead of
  reporting `failed`. Claude Code's unreachable stream recorded live (2.1.289, four ways, fake
  key, no tokens); the Codex release path is tested with recorded and synthetic streams only.
  New e2e scenario `unreachable`. Branch `claude/great-kalam-f5b5f7`.
- 2026-11-10: A7 custom CA: `sandbox.extra_ca_certs` (validated PEM, copied into a root-owned
  tmpfs, `NODE_EXTRA_CA_CERTS` + combined `SSL_CERT_FILE`). Verified that Claude Code 2.1.289
  and Codex 0.167.0 honour these against a local TLS server; Codex's WebSocket
  client uses `SSL_CERT_FILE` in place of its roots. Egress proxy unchanged (CONNECT-only, no TLS).
