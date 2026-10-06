# AgentFund worker

`agentfund` is the command-line tool for both sides of AgentFund:

- **Maintainers** use it to generate a signing key, validate task manifests and sign the task lock.
- **Donors** use it to review a project's signed tasks, and then to run them: each task is claimed
  from an AgentFund server, verified against the key the donor pinned, executed by a coding agent
  inside a locked-down Docker sandbox, checked, pushed as a branch with a pull request, and reported.

The worker runs the **unmodified Claude Code CLI** as its coding agent, under the donor's own
credentials, on the donor's own machine. See [Whose credentials, whose bill](#whose-credentials-whose-bill).

New here? Run `make demo` from the repository root ([Quickstart](../docs/quickstart.md)): it drives
this binary through a full run without spending tokens. The task-oriented guides are the
[Donor guide](../docs/donors.md) and the [Maintainer guide](../docs/maintainers.md); this page is the
reference for the tool itself.

The normative contract lives in [`../spec`](../spec): `manifest.md` (manifests, lock, signature,
verification chain), `protocol.md` + `openapi.yaml` (wire protocol v1).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/agentfund/agentfund/main/scripts/install.sh | sh
# or, from a checkout (Go 1.27+):
make -C worker build        # → worker/bin/agentfund
```

The installer honours `AGENTFUND_REPO`, `AGENTFUND_VERSION`, `AGENTFUND_INSTALL_DIR` and verifies
the SHA-256 of the archive against the release's checksum file.

Requirements for running tasks: Docker, `git`, and — for GitHub projects — the `gh` CLI logged in
(`gh auth login`). Two container images must be present locally:

| Image | Default reference | Build |
| --- | --- | --- |
| Sandbox | `agentfund/sandbox:dev` | `make -C worker sandbox-image` (from `images/sandbox`) |
| Egress proxy | `agentfund/egress-proxy:dev` | `make -C worker egress-image` (from `images/egress-proxy`) |

Pin them by digest in `config.yaml` once you use published images
(`image: "…/sandbox@sha256:…"`): a tag can be re-pointed, a digest cannot.

## For maintainers

```sh
agentfund keygen                      # → ~/.config/agentfund/keys/default.key (+ .pub), prints pubkey + fingerprint
$EDITOR agentfund.yaml                # paste the pubkey
agentfund validate tasks/             # schema + lints
agentfund sign tasks/                 # → tasks/MANIFEST.lock + tasks/MANIFEST.lock.minisig
git add agentfund.yaml tasks && git commit && git push
```

| Command | What it does |
| --- | --- |
| `keygen [--name N] [--out DIR] [--no-password] [--force]` | Ed25519 key in minisign format. Secret key `0600`, password-protected (scrypt, compatible with the stock `minisign` tool) unless `--no-password`. Password from `$AGENTFUND_KEY_PASSWORD` or a prompt. |
| `validate <tasks-dir> [--strict]` | Strict YAML (no anchors, aliases, merge keys, tags, multiple documents), JSON Schema, `id` = file name, `depends_on` exists and is acyclic, `../agentfund.yaml` if present. Warnings: write scope `**`/`*`, trivially-true `verify`, prompt under 80 characters, `max_tokens` above 5,000,000, missing `timeout_minutes`. Error: write scope naming never-writable paths. `--strict` fails on warnings. |
| `sign <tasks-dir> [--key PATH] [--rotate-from OLDKEY]` | Validates, then writes the lock (2-space JSON, sorted by path, trailing newline) and one prehashed minisign signature over it. Key from `--key`, `$AGENTFUND_KEY`, or the only key in the keys directory. `--rotate-from` appends a rotation link signed by the old key; existing links are preserved. |

The signature verifies with the stock tool:
`minisign -Vm tasks/MANIFEST.lock -P "$(yq .pubkey agentfund.yaml)"`.

## For donors

```sh
agentfund login https://fund.example                 # stores the server's af_… key (0600)
agentfund approve https://fund.example/gridrs        # review prompts, pin key + commit
agentfund dry-run gridrs                             # what would run, and why not
export CLAUDE_CODE_OAUTH_TOKEN=…                     # or ANTHROPIC_API_KEY=…  (see below)
agentfund work gridrs --budget 5M --schedule "22:00-06:00"
agentfund status
```

| Command | What it does |
| --- | --- |
| `login <server-url> [--key-stdin]` | Reads the server API key, checks it with `GET /v1/me`, stores it in `credentials.yaml`. |
| `approve <server-url>/<project> [--yes] [--no-pager] [--pubkey KEY] [--commit SHA] [--follow-unchanged-lock \| --no-follow]` | Negotiates the protocol, clones the repo, verifies the lock at the server's pinned commit, prints the **key fingerprint** (compare it with the server's Audit tab) and whether the key in the repo's `agentfund.yaml` equals the key the server publishes, shows every manifest in full through `$PAGER`, then the server's trust tier and caps next to yours and which one binds, asks, then pins `{pubkey, approved_commit, approved_lock_sha256}`. Refuses when the two key channels disagree (and no valid rotation chain connects them) unless you pass the key you trust with `--pubkey`. Run again to approve a newer commit; re-approving also clears the `retry_failed_after` cooldown of that project's earlier failed runs. It also asks whether to keep working when the project moves to a newer commit whose signed task list is byte-identical (stored per project as `follow_unchanged_lock`; `--follow-unchanged-lock` / `--no-follow` non-interactively, `--yes` alone leaves it off): the prompts cannot change, the repository's code may have, and it runs only inside the sandbox. |
| `dry-run <project> [-n 5]` | Fetches and verifies like `work`, evaluates your policy, prints the next N open tasks with full signed prompts and the reason for every skip. No claims, no execution. |
| `work <project> [--budget 200m] [--schedule "02:00-06:00"] [--max-concurrent 1] [--once] [--task ID] [--json] [--poll 30s] [--sandbox-image REF] [--egress-proxy-image REF]` | The loop described below. SIGINT/SIGTERM stops the sandbox and releases active claims. |
| `status [--json] [--recent 10]` | Running and recent runs, tokens today/this week against the caps, rate-limit backoff, and active claims according to each server (`GET /v1/me/claims`). |
| `logs [claim] [--path] [--report]` | Lists run logs, or prints one. `--report` shows the sidecar with the digest and the report that was sent. |
| `daemon install [--project P] [--uninstall] [--now]` | Writes a systemd user unit (Linux) or launchd agent (macOS) running `work`; prints how to enable it. Starts nothing without `--now`. Never embeds credentials. |

`<project>` is `<server-url>/<slug>`, or just the slug when it is unique among your approvals.

`work --once` exit status: `0` a task completed and its report was accepted · `3` nothing could be
started (nothing claimable, policy, or the project moved past your approval) · `4` a task was
claimed but did not complete, or the server did not accept its report · `1` error. With `--json` each finished attempt is one JSON object on
stdout (`task`, `claim`, `outcome`, `reason`, `tokens_in`, `tokens_out`, `branch`, `pr_url`,
`head_sha`, `log_file`, `log_digest`, `report_accepted`, and `report_error` when the server refused
or could not be reached — transient failures are retried a few times with backoff first).

### Environment variables

| Variable | Meaning |
| --- | --- |
| `AGENTFUND_CONFIG_DIR` | Config directory (default `$XDG_CONFIG_HOME/agentfund`, else `~/.config/agentfund`). |
| `AGENTFUND_DATA_DIR` | State directory: repo cache, logs, accounting (default `$XDG_DATA_HOME/agentfund`, else `~/.local/share/agentfund`). |
| `AGENTFUND_API_KEY` | Server API key (`af_…`), overrides `credentials.yaml`. A project can name its own variable with `api_key_env`. |
| `AGENTFUND_KEY`, `AGENTFUND_KEY_PASSWORD` | Default signing key file; password for encrypted keys. |
| `AGENTFUND_SANDBOX_IMAGE`, `AGENTFUND_EGRESS_PROXY_IMAGE` | Image overrides for `work` (also `--sandbox-image`, `--egress-proxy-image`). |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | Your coding-agent credentials (read at run time only; see below). |
| `PAGER` | Pager used by `approve`. |

### Configuration

`~/.config/agentfund/config.yaml` is created by `approve`, with a comment on every knob. Defaults
are conservative:

```yaml
global:
  tokens_per_day: 10m                    # per local calendar day, all projects
  tokens_per_week: 40m                   # Monday 00:00 – Monday 00:00, local time
  max_tokens_per_task: 5m                # manifests above this are refused
  new_project_max_tokens_per_task: 5m    # while the server reports trust tier "new"
  schedule: []                           # ["02:00-06:00"], ["22:00-06:00"] (wraps); [] = always
  max_concurrent: 1
  allowed_git_hosts: ["github.com"]      # "file" allows file:// URLs (tests)
  auto_follow_signed_updates: false      # true = run newer, validly signed task sets unreviewed
  follow_unchanged_lock: false           # true = run newer commits whose lock is byte-identical
  retry_failed_after: "24h"              # do not re-claim a task that just failed here
  claude_token_command: ""               # optional: command printing the agent's OAuth token
  sandbox:
    image: "agentfund/sandbox:dev"
    egress_proxy_image: "agentfund/egress-proxy:dev"
    cpus: "2"
    memory: "4g"
    pids: 512
    allow_git_host: false                # true only if verify must fetch from the git host
    extra_allow_hosts: []                # extra host[:port] the sandbox may reach
    pass_env: []                         # extra variable NAMES passed to the agent process
    docker: "docker"
  runner:
    name: "claude-code"
    model: ""
projects:
  "https://fund.example/gridrs":
    server: https://fund.example
    slug: gridrs
    pubkey: RWQ…                         # what you pinned
    approved_commit: 3f2c…
    approved_lock_sha256: 9a41…
    approved_at: 2026-10-06T18:00:00Z
    # optional overrides: tokens_per_day, tokens_per_week, max_tokens_per_task, schedule,
    # auto_follow_signed_updates, follow_unchanged_lock, api_key_env
```

Token amounts accept `200m`, `5M`, `750k`, `1.5m` or plain integers; `0` means "no cap". A task's
full `max_tokens` is reserved before it starts and settled to the real usage afterwards, so caps
cannot be overshot; the accounting is persisted (`state.json`) and survives restarts. Per-project
caps apply in addition to the global ones and a per-project task ceiling can only tighten the
global one. For a "new" project the ceiling is the minimum of your caps and the caps the server
publishes — nothing a server says ever loosens your policy.

## What `work` does for each task

1. **Policy pre-check** against the task listing, and an **approval pre-check**: the repository is
   fetched and the task's commit must be covered by your approval (the approved commit, an
   ancestor, or a follow policy you enabled). If the project has moved on, nothing is claimed;
   `work`, `dry-run` and `status` say "project moved to <sha>; run `agentfund approve <ref>` to
   review and approve it". Then **claim**. A heartbeat goroutine extends the
   lease every `heartbeat_interval_seconds`, carrying cumulative tokens and the phase; if the server
   answers `claim-not-active`, the run is stopped and a `failed` report ("claim lost: lease no
   longer active", real tokens) is still sent; the server stores it flagged late, and a refusal
   is only logged.
2. **Verification chain** (spec/manifest.md §4, steps 1–4) on a host-side bare clone under
   `~/.local/share/agentfund/repos/`: the claimed commit exists; the lock's minisign signature
   (prehashed variant only, file signature *and* global signature) chains to the key **you pinned**,
   following at most 16 rotation links; the lock is schema-valid and lists exactly the
   `tasks/*.yaml` of that commit with matching SHA-256; the claimed task's hash equals the claim's
   `content_hash`; the manifest parses strictly; the commit is your approved commit or an ancestor
   (or a follow policy you enabled accepts it). Any failure → report `verification_failed`; nothing
   from the repository is executed. The key in the repository's `agentfund.yaml` is never used.
3. **Policy** against the verified manifest (caps, ceilings, schedule, concurrency, git host,
   backoff), with the reservation made atomically. A refusal **releases** the claim.
4. **Sandbox**: a per-run `--internal` Docker network; the egress proxy sidecar attached to that
   network and the default bridge with `ALLOW_HOSTS=api.anthropic.com[,extras]` (the project's git host only with
   `sandbox.allow_git_host: true`); the
   sandbox container on the internal network only, `--cap-drop ALL`, `no-new-privileges`,
   read-only root, tmpfs `/tmp` and home, pids/CPU/memory limits, no bind mounts, no Docker socket.
   The repository at the claimed commit is streamed in as a tar built on the host from git objects:
   no `.git`, no `tasks/`, no `agentfund.yaml`, `scope.read` applied; the tree is root-owned and
   read-only to the agent, files matching `scope.write` are agent-owned, directories where a write
   glob can match are root-owned `1777` (sticky), and `.github/` stays closed.
5. **Agent**: `claude -p --output-format stream-json --verbose …` as user `agent` (uid 10001) in
   `/work`, prompt on stdin, verbatim. Tokens are metered from the stream (input + cache creation +
   cache read → `tokens_in`; output → `tokens_out`; the final `result` totals win). The sandbox is
   killed at `max_tokens` (→ `budget_exceeded`) or `timeout_minutes` (→ `timeout`). A rate limit →
   claim released with the tokens burned so far, exponential backoff with jitter, nothing claimed
   until it ends. A provider that rejects your credentials stops the worker.
6. **Verify**: the manifest's `verify` via `sh -c` in the same sandbox, network still restricted.
   Non-zero exit → `failed`.
7. **Scope check**, entirely on the host: the working tree is streamed out as a tar and read in
   memory — never extracted. Added/modified/deleted paths and mode changes are derived against the
   git tree. The whole run is discarded (`verification_failed`) if any change is outside
   `scope.write`, touches `agentfund.yaml`, `tasks/**`, `.github/**` or anything spelled like
   `.git`, is a symlink, hard link, device or FIFO, has an unclean name, exceeds 5 MB per file or
   50 MB in total, or contains the credential the agent was given. Untracked paths ignored by the
   repository's `.gitignore` (as of the claimed commit) are skipped.
8. **Publish**: the commit is assembled on the host with git plumbing (blobs from memory, a private
   index — the sandbox's files never touch the host file system), with trailers `AgentFund-Task`,
   `AgentFund-Claim`, `AgentFund-Manifest-SHA256`, on branch `agentfund/<task-id>-<claim short>`.
   For GitHub: `gh repo fork --clone=false`, push to your fork with `gh` as credential helper,
   `gh pr create` against the project's base branch. Git credentials never enter the sandbox.
9. **Report** `completed` (branch, PR URL, head SHA, `verify_exit_code` 0, log digest) or the
   failure status, then tear everything down — also on panic or signal. Orphaned containers,
   networks and volumes labelled `agentfund.run` are removed at the next start.
  Report and release requests are retried a few times with backoff on network errors, 5xx and 429; a `429` from the server with `Retry-After` pauses the loop for that long.

### Logs

`~/.local/share/agentfund/logs/<date>/<claim>.log` holds one JSON object per line: the claim, the
verification result, the raw manifest, the full prompt, every agent stream event, verify output,
each changed file, egress proxy allow/deny lines and the outcome. `log_digest` in the report is the
SHA-256 of that file at the moment the report was built; what happens afterwards (the report sent,
the server's answer) is written to `<claim>.report.json` next to it. Agent credentials are scrubbed
from every line.

## Whose credentials, whose bill

- The worker runs the unmodified Claude Code CLI, published by Anthropic, inside the sandbox image.
  It does not change, remove or restrict the CLI's built-in authentication methods.
- The agent authenticates as **you**. The worker forwards whichever of `CLAUDE_CODE_OAUTH_TOKEN`
  (from `claude setup-token`) and `ANTHROPIC_API_KEY` is set in your environment — both if both are
  set; the CLI decides which to use. `claude_token_command` is used when neither is set. Other
  variables (`ANTHROPIC_BASE_URL`, Bedrock/Vertex settings, …) are passed only if you list their
  names in `sandbox.pass_env`, and their hosts are reachable only if you also list them in
  `sandbox.extra_allow_hosts`. With no credential at all, `work` stops before claiming anything.
- AgentFund never collects, stores or relays these credentials. They are read from your
  environment at run time and handed to `docker exec -e NAME` (value in the docker CLI's process
  environment): not in argv, not in an image, not in `config.yaml` or `credentials.yaml`, not in
  logs or reports, never sent to an AgentFund server. `credentials.yaml` only holds the AgentFund
  server's own `af_…` key.
- Usage is metered and billed to you, under your own agreement with your provider. Projects, the
  AgentFund server and its operators pay for nothing and receive no credential.
- Whether running donated tasks fits the plan you have is your decision to make from the
  provider's own terms — this project makes no claims on their behalf. Anthropic's Claude Code
  documentation says that advertised usage limits for Pro and Max plans "assume ordinary, individual
  usage of Claude Code and the Agent SDK". Read:
  [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and the
  [Usage Policy](https://www.anthropic.com/legal/aup). An API key
  (`ANTHROPIC_API_KEY`, pay-as-you-go under the Commercial Terms) is the unambiguous option.

## What the sandbox does and does not protect

**It does:**

- Keep the agent and `verify` away from your files, your SSH and git credentials, your `gh`
  session and the Docker socket: nothing from the host is mounted, and publishing happens on the
  host from data.
- Limit network egress to HTTPS `CONNECT` tunnels to the model API (plus what you add). The
  project's git host is **not** reachable by default — the sandbox has no `.git` and no git
  credentials. Everything else is refused and logged by the proxy; the sandbox has no other route
  and no external DNS.
- Make out-of-scope changes impossible to publish: permissions stop most of them inside the
  sandbox, and the host-side scope check discards the whole run for the rest.
- Bound spend (token cap, wall-clock cap, day/week caps) and resources (CPU, memory, pids).
- Guarantee that only prompts signed by the key you pinned, at a commit your approval covers, run.

**It does not:**

- Provide hypervisor-grade isolation. **Docker is not a hypervisor**: the container shares your
  kernel, and a kernel or container-runtime vulnerability could let code escape. If that risk
  matters to you, run the worker inside a VM or on a dedicated machine. Rootless Docker or a
  user-namespace-remapped daemon reduces the impact further.
- Hide your agent credential from the agent. The CLI needs it, so it is in the environment of a
  process that executes a prompt written by someone else, and that process can reach the allowlisted
  hosts. A malicious prompt could try to send the credential to a destination on an allowlisted host
  (which is why the git host is off the allowlist by default — every host you add with
  `allow_git_host` or `extra_allow_hosts` widens this). Mitigations: you read every prompt before approving and prompts cannot
  change without your re-approval (unless you enabled a follow policy); the default allowlist is one host;
  a change set containing the credential is discarded; the token from `claude setup-token` can only
  make model requests and can be revoked. Use a dedicated, revocable credential.
- Judge the work. `verify` and the project's CI decide whether a change is good; the scope check
  only decides where it may be. A pull request is a proposal for a maintainer to review.
- Review prompts for you. `approve` shows them; `auto_follow_signed_updates: true` means new
  prompts from the maintainer run unreviewed.
- Protect against a malicious container image. Build the images yourself or pin digests.
- Stop the model provider from seeing the repository content the agent reads — that is how the
  agent works.

Known limits of this version: the model API hosts are reachable for the whole run including
`verify`; DNS names on the allowlist are resolved by the proxy at connect time (it refuses private
addresses); `timeout_minutes` covers agent + verify, while cloning and publishing are bounded only
by the lease.

## Development

```sh
make -C worker test               # unit tests: no Docker, no network (go test ./...)
make -C worker test-integration   # full pipeline in Docker against a fake server (go test -tags integration ./...)
make -C worker e2e-images         # test images whose `claude` is cmd/mock-agent, one per scenario
make -C worker sync-spec          # re-copy ../spec/schemas into the module (a test fails on drift)
goreleaser check && goreleaser build --snapshot --clean   # from the repo root → worker/dist
```

Package map (`internal/`): `spec` strict YAML + embedded JSON Schemas + globs · `minisign` key and
signature format · `lockfile` lock, rotation chain, signing · `verify` verification chain steps 1–4
· `policy` pure policy engine · `store` persisted reservations/usage · `config` config and
credentials files · `api` wire client (checked against `openapi.yaml`) · `gitx` hardened git
plumbing · `scope` materialisation plan and tar diff · `sandbox` Docker network/sidecar/container ·
`runner` agent interface, stream meter, Claude Code runner (`CLAUDE_CODE_NOTES.md`) · `githost`
GitHub (`gh`) and local publishers · `logs` run log + scrubbing · `pipeline` the per-task engine
and loop · `lint` validate rules · `cli` commands. `apitest` and `testutil` are test-only.

The integration tests use `images/sandbox/Dockerfile.e2e`, where `claude` is a mock that emits the
real stream-json shapes and performs a scripted behaviour chosen by the image
(`MOCK_AGENT_SCENARIO`); the worker has no test switches.
