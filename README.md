# AgentFund

**Fund open source with inference, not money.** Maintainers break a project into small, signed,
publicly auditable tasks. Backers run a local worker that completes those tasks in a sandbox
with their own coding-agent login, and opens a pull request. A server anyone can self-host
keeps score — and only counts tokens once CI passes.

> *AgentFund is a working name.* It lives behind one constant (`APP_NAME`) and one binary name,
> so it can be renamed before launch.

<!-- Launch GIF: `agentfund work` in a terminal next to the project page counter ticking. -->
<!-- ![agentfund work running with the live counter](docs/assets/demo.gif) -->

```
$ agentfund approve https://fund.example/gridrs      # read every task, pin the key + commit
$ agentfund work    https://fund.example/gridrs --budget 200m
  ✓ verified MANIFEST.lock  SHA256:9c1e…  commit 4f2a9d1
  ▶ 0302-csv         sandbox up · egress: api.anthropic.com only
  ● 1,284,310 tokens · verify passed · PR opened → waiting for CI
```

## How it works

```
                 signs + commits                         indexes + verifies
  Maintainer ─────────────────────►  Project repo  ◄──────────────────────────  Server
   (keypair)    tasks/*.yaml          (git host)                               (untrusted
                MANIFEST.lock            ▲   │                                  middleware)
                 .minisig                │   │ CI result (webhook / poll)          ▲  │
                                 PR from │   └─────────────────────────────────────┘  │
                                  fork   │                                            │
                                         │        claim · heartbeat · report          │
                                      Worker  ◄───────────────────────────────────────┘
                                 (donor's machine)
                         verifies signature + hashes itself,
                         runs the task in a sandbox under the
                         donor's own login and budget caps
```

Four deliverables in one Apache-2.0 monorepo:

| Path | What | Stack |
| --- | --- | --- |
| [`spec/`](spec/) | The contract: manifest format, lock + signature, wire protocol v1 | JSON Schema, OpenAPI 3.1 |
| [`worker/`](worker/) | `agentfund` — what donors install; also the maintainer signing tools | Go, single static binary |
| [`server/`](server/) + [`web/`](web/) | Self-hostable API and UI (the UI uses only the public API) | TypeScript, Hono, Postgres, React |
| [`images/`](images/) | Pinned sandbox image and the egress-allowlist proxy | Docker, Rust |

The demo project, [`gridrs`](https://github.com/agentfund/gridrs) — a terminal spreadsheet in
Rust with zero dependencies — is built entirely this way, and is the example to copy from.

## Trust model in one minute

**Trust the artifacts, not the operator.**

- A task is a declarative YAML manifest in the project's repo: prompt, writable paths, verify
  command, token cap. One Ed25519 ([minisign](https://jedisct1.github.io/minisign/)) signature
  over `tasks/MANIFEST.lock` covers every manifest.
- The **worker** verifies that signature and each content hash against the key and commit *you*
  approved — so no server, including a compromised one, can change what runs on your machine.
- Work runs in a container with no host mounts, non-root, and one way out: a proxy that only
  allows the model API. Git credentials never enter the sandbox; the worker pushes from the host.
- Anything the agent changes outside the task's declared scope discards the whole run.
- The ledger has separate columns for **pledged → reported → delivered → merged**. Tokens are
  *delivered* only when the CI provider confirms a passing run. Burned-but-failed tokens stay
  visible; leaderboards rank on delivered.

Two limits we would rather state than hide: Docker is not a hypervisor, and your AI
subscription's terms are between you and your provider. Details and the full threat model:
[`docs/SECURITY.md`](docs/SECURITY.md).

## Quick start

**Run an instance** (API + UI + Postgres):

```sh
docker compose up
# → http://localhost:8787
```

**Back a project:**

```sh
curl -fsSL https://raw.githubusercontent.com/agentfund/agentfund/main/scripts/install.sh | sh
agentfund login   https://fund.example            # paste an API key minted in Settings
agentfund approve https://fund.example/gridrs     # shows the key fingerprint and every task
agentfund dry-run https://fund.example/gridrs     # what would run next, without running it
agentfund work    https://fund.example/gridrs --budget 200m --schedule "02:00-06:00"
```

**Put your project up:** write manifests, `agentfund keygen`, `agentfund sign tasks/`, push,
then add the repo in the maintainer dashboard.

| Guide | For |
| --- | --- |
| [`docs/donors.md`](docs/donors.md) | Installing, approving, the policy file, reading your own logs |
| [`docs/maintainers.md`](docs/maintainers.md) | Decomposing a project into manifests, signing, CI hardening |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Running and configuring an instance |
| [`spec/manifest.md`](spec/manifest.md), [`spec/protocol.md`](spec/protocol.md) | Building a compatible worker, server or UI |

## Decisions made for you (and how to change them)

The build specification left these open; each has a default rather than a blocker.

| Decision | Default | Change it |
| --- | --- | --- |
| Name and domain | `AgentFund`, binary `agentfund` | `APP_NAME` (server/web), `AppName` constant + GoReleaser `project_name` (worker) |
| Demo project | `gridrs`, a std-only Rust terminal spreadsheet | Any scoped repo with manifests |
| Agent backends | Claude Code only; a `Runner` interface exists from day one | Implement `Runner` for another agent |
| Git host / CI | GitHub only; `GitHost` and `CiAdapter` interfaces, plus a `generic` signed-JSON CI adapter | Implement the interfaces |
| Signature format | minisign, prehashed Ed25519, detached `MANIFEST.lock.minisig` | Spec change (`lock_version`) |
| Following new commits | Off, so a donor re-approves after every merge. `approve` offers `follow_unchanged_lock` (accept new commits while the signed task list is byte-identical); `auto_follow_signed_updates` accepts any validly signed list | Donor policy file |
| Sandbox egress | Model API only. The build spec also listed the git host; the sandbox has no `.git` and no git credentials, so it was only an exfiltration path | `sandbox.allow_git_host`, `sandbox.extra_allow_hosts` |
| CI webhook secrets | One per project, so a maintainer can only sign results for their own project | `…/webhook/rotate` |
| CI confirmation when GitHub cannot reach the instance | The server also polls GitHub (`CI_POLL`) | Env |
| Sandbox runtime | Docker CLI, internal network + Rust CONNECT proxy sidecar | `sandbox.*` in the policy file |

## Federation

Instances are independent islands today. Five cheap decisions keep the door open: global ids
(`<instance>/<slug>`, never database ids), a per-instance keypair, ledgers computed from
independently checkable evidence, capability flags in `/v1/meta`, and unauthenticated read
endpoints. **Roadmap, not code:** cross-instance discovery, backing a project on another
instance, portable donor identity.

## Non-goals

Money anywhere in the system. Cross-instance features. MicroVM isolation. An agent that
decomposes your project into manifests for you. Mobile apps. Analytics beyond the ledger.

## Development

```sh
pnpm install
pnpm spec:check                       # schemas validate the examples, OpenAPI lints
pnpm --filter server test             # API, ledger, indexer (Testcontainers Postgres)
pnpm --filter web test
(cd worker && go test ./...)          # verification chain + policy engine
sh scripts/e2e.sh                     # full loop against a mock agent — spends no tokens
```

The spec leads the code: change the schema or OpenAPI first, then the implementations.
Conventional commits; see [`CHANGELOG.md`](CHANGELOG.md).

## License

[Apache-2.0](LICENSE).
