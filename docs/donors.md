# Donor guide

New here? Run the [zero-token demo](quickstart.md) first; [Concepts](concepts.md) explains the
moving parts.

You are about to let a program run prompts written by a stranger, on your machine, billed to
your AI account. This guide says what that program does, what limits it, what it cannot
protect you from, and how to check all of it yourself.

## The short version

```sh
curl -fsSL https://raw.githubusercontent.com/ghvstcode/agentfund/main/scripts/install.sh | sh   # the CLI
make -C worker images                          # sandbox + proxy images, from a checkout
export CLAUDE_CODE_OAUTH_TOKEN=...             # or ANTHROPIC_API_KEY; the bill is yours
agentfund login https://fund.example           # store the instance's API key (af_...)
agentfund approve https://fund.example/gridrs  # read every prompt, pin the key and commit
agentfund dry-run gridrs                       # what would run, and why not; claims nothing
agentfund work gridrs --once --budget 2m       # one task, capped, then exit
agentfund status                               # tokens against caps, running and recent runs
agentfund logs                                 # what was actually run
```

> [!IMPORTANT]
> This is pre-release software. The full loop is proven against a mock agent, and the GitHub
> path (push, pull request, Actions, delivery, merge) has been proven once by hand. A real
> model (Claude Code with Sonnet) has completed the sample project's tasks in the sandbox; a
> larger project and a pull request from a fork have not been run yet.
> The [Status section of the README](../README.md#status) is kept current. Treat a first run
> as a test: `--once`, a small budget, and read the log afterwards.

**Contents:** [1. Install](#1-install) · [2. Log in](#2-log-in-to-an-instance) ·
[3. Approve](#3-approve-a-project) · [4. Preview, work, watch](#4-preview-work-watch) ·
[5. Policy file](#5-the-policy-file) · [6. Sandbox](#6-what-the-sandbox-does-and-does-not-protect) ·
[7. Credentials and billing](#7-whose-credentials-whose-bill) · [8. Logs](#8-reading-your-own-logs) ·
[9. Ledger](#9-what-the-ledger-columns-mean-for-you) · [10. Rate limits](#10-rate-limits-and-backoff) ·
[11. Troubleshooting](#11-troubleshooting) · [12. Uninstalling](#12-uninstalling)

## 1. Install

```sh
curl -fsSL https://raw.githubusercontent.com/ghvstcode/agentfund/main/scripts/install.sh | sh
```

No release is published yet. Until there is one, build from a checkout (Go 1.27+):
`cd worker && make build` writes `worker/bin/agentfund`.

The installer detects OS and architecture (Linux and macOS, amd64 and arm64), downloads the
release archive, verifies its SHA-256 against the release's checksum file, and installs to
`~/.local/bin` (`/usr/local/bin` as root). It honours `AGENTFUND_REPO`, `AGENTFUND_VERSION`,
`AGENTFUND_INSTALL_DIR` and `AGENTFUND_BASE_URL` (a mirror; needs `AGENTFUND_VERSION`).

### Requirements

| Need | Why |
| --- | --- |
| Docker (the `docker` CLI and a running daemon) | The sandbox and its egress proxy are containers. |
| `git` | The worker clones the project on the host to verify it. |
| `gh`, logged in (`gh auth login`) | The worker forks the project, pushes the branch and opens the PR as **you**. |
| The sandbox and egress-proxy images | A released binary uses the images published with it, by digest: `agentfund version` names them, `docker pull` each once. A build from source uses `agentfund/sandbox:dev` and `agentfund/egress-proxy:dev`: `make -C worker images`. |
| `CLAUDE_CODE_OAUTH_TOKEN` (printed by `claude setup-token`) or `ANTHROPIC_API_KEY` (from the Anthropic Console), exported in the shell that runs `agentfund work`; with `runner.name: codex`, `CODEX_API_KEY` or `OPENAI_API_KEY` | The agent runs under your credentials. With neither set and no `claude_token_command` in the config, `work` stops before claiming anything. |

Read [Whose credentials, whose bill](#7-whose-credentials-whose-bill) before choosing one.

## 2. Log in to an instance

An AgentFund instance is a website plus an API. Sign in to it in the browser, open
**Settings**, create an API key (prefix `af_`; it is shown once), then:

```sh
agentfund login https://fund.example            # prompts for the key, no echo
printf '%s\n' "$KEY" | agentfund login https://fund.example --key-stdin
```

The worker checks the key with `GET /v1/me` and stores it in
`~/.config/agentfund/credentials.yaml` (mode 0600). That file holds only AgentFund server
keys. Your Claude credentials are never written anywhere by this tool.

## 3. Approve a project

```sh
agentfund approve https://fund.example/gridrs
```

Nothing from the project runs during `approve`. It:

1. Asks the instance for the repository URL, the maintainer key it registered, and the commit
   it currently pins.
2. Refuses if the repository's host is not in your `allowed_git_hosts` (default: `github.com`).
3. Clones the repository into `~/.local/share/agentfund/repos/`, then verifies the signature on
   `tasks/MANIFEST.lock` at that commit and the SHA-256 of every manifest listed in it.
4. Prints the maintainer key from two channels: the server's, and the repository's
   `agentfund.yaml`. If they differ and no signed rotation chain connects them, it refuses.
   Ask the maintainer out of band which is right, then pass it with `--pubkey <key>`.
5. Prints `FINGERPRINT TO PIN:  SHA256:...`. **Compare it** with the *Key fingerprint* on the
   project's **Audit** tab: they must be identical. If the maintainer publishes it elsewhere
   too (README, website), compare that: the more independent channels agree, the less each
   has to be trusted.
6. Shows every manifest in full through `$PAGER` (default `less -R`): prompt, `scope.write`,
   `scope.read`, `verify`, `max_tokens`, `timeout_minutes`. Then the total if every task ran
   to its cap, and the server's trust tier and caps next to yours, with which one binds.
   **Read it.** The prompts are what your agent will be told, verbatim, and `verify` is a
   shell command that will run in the sandbox. Look for anything not plainly about building
   the project: sending data somewhere, printing environment variables, writing outside what
   the title suggests.
7. Asks `Pin this key and commit? [y/N]`.
8. Asks `Keep working when the project moves to a newer commit whose signed task list is
   byte-identical to what you just reviewed? [y/N]` and stores the answer for this project as
   `follow_unchanged_lock` (see [When the project's commit moves](#when-the-projects-commit-moves)).

| Flag | Effect |
| --- | --- |
| `--yes` | Skip both questions. Manifests are printed, not paged. `follow_unchanged_lock` stays as it is (off by default). |
| `--follow-unchanged-lock` / `--no-follow-unchanged-lock` | Answer question 8 on the command line. Mutually exclusive. |
| `--no-pager` | Print manifests instead of paging. |
| `--commit <sha>` | Approve this commit instead of the server's pin. |
| `--pubkey <key>` | Pin this key instead of the one the server publishes. |

Approval pins three values in `~/.config/agentfund/config.yaml`:

| Field | Meaning |
| --- | --- |
| `pubkey` | The only key (plus keys it rotates to, by signed statement) whose signature the worker will ever accept for this project. The key in the repository is never consulted at run time. |
| `approved_commit` | Tasks from this commit and its ancestors may run. |
| `approved_lock_sha256` | Hash of the task set you read, used by `follow_unchanged_lock`. |

Run `approve` again at any time to approve a newer commit.

## 4. Preview, work, watch

`<project>` is the full `<server-url>/<slug>`, or just the slug when it is unique among your
approvals.

### dry-run

```sh
agentfund dry-run gridrs          # -n 10 for more than the default 5
```

Fetches and verifies exactly as `work` does, evaluates your policy, and prints the next open
tasks with the full signed manifest, each marked `WOULD RUN (commit ..., approval: ...)` or
`SKIPPED: <reason>`. It claims nothing and executes nothing.

### work

```sh
agentfund work gridrs --once --budget 2m                       # one task, then exit
agentfund work gridrs --budget 20m --schedule "02:00-06:00"    # loop inside a window
```

A real run against the mock agent:

```
$ agentfund work hello --once
22:08:30  working on http://localhost:8787/hello (file:///…/hello-project), up to 1 task(s) at a time
22:08:31  0001-slugify: running claude-code in the sandbox (max 1M tokens, 20 min)
0001-slugify: completed (8,100 in / 150 out tokens) — branch agentfund/0001-slugify-17y1xtqp pushed to file:///…/hello-project
```

| Flag | Effect |
| --- | --- |
| `--budget 20m` | Token budget for this invocation. A further limit: the caps in the config still apply. |
| `--schedule "22:00-06:00,12:00-13:00"` | Local-time windows in which new tasks may start. Replaces the configured schedule for this invocation; `""` means any time. A running task is not interrupted when a window closes. |
| `--max-concurrent N` | Tasks at once (1 to 16). |
| `--once` | At most one task, then exit. |
| `--task 0302-csv` | Only this manifest id. |
| `--json` | One JSON object per finished attempt on stdout: `task`, `claim`, `outcome`, `reason`, `tokens_in`, `tokens_out`, `cost_estimate`, `branch`, `pr_url`, `head_sha`, `log_file`, `log_digest`, `report_accepted`, and `report_error` when the server refused the report or stayed unreachable after a few retries. |
| `--poll 30s` | Idle delay between looks at the queue. |
| `--sandbox-image`, `--egress-proxy-image` | Image overrides for this invocation. |

| Exit status of `work --once` | Meaning |
| --- | --- |
| `0` | A task completed and the server accepted its report. |
| `3` | Nothing could be started: nothing claimable, policy, or the project moved past your approval. |
| `4` | A task was claimed but did not complete, or the server did not accept the report. |
| `130` | Interrupted. |
| `2`, `1` | Usage error; any other error. |

Ctrl-C (or SIGTERM) kills the sandbox and releases active claims, reporting the tokens burned
so far.

For each task, in order: policy pre-check → claim → fetch and verify (signature, hashes,
approval) → policy against the verified manifest, reserving `max_tokens` → start the sandbox →
run the agent → run `verify` → scope check on the host → build the commit on the host, push
to your fork, open the PR → report. `worker/README.md` describes each step in detail.

### status

```sh
agentfund status            # --json, --recent 20
```

Tokens today and this week against your caps, any backoff (rate limit or unreachable API),
running tasks with phase and lease expiry, recent runs with their outcome (10 by default), and
your active claims as each server sees them.

### daemon install

```sh
agentfund daemon install --project gridrs          # writes the unit, starts nothing
agentfund daemon install --project gridrs --now    # also enables and starts it
agentfund daemon uninstall --project gridrs --now
```

Writes a service definition that runs `agentfund work <project>` and prints how to enable it.
`--project` is optional when you have exactly one approved project. The service runs `work`
with no flags, so set your budget and schedule in the config file. Credentials are never
embedded:

| | Linux (systemd user unit) | macOS (launchd agent) |
| --- | --- | --- |
| File | `~/.config/systemd/user/agentfund-<slug>.service` | `~/Library/LaunchAgents/dev.agentfund.worker.<slug>.plist` |
| Credentials | Create `~/.config/agentfund/worker.env` (chmod 600) with `CLAUDE_CODE_OAUTH_TOKEN=...` or `ANTHROPIC_API_KEY=...`. | launchd does not inherit your shell environment. Set `claude_token_command` in the config, e.g. `security find-generic-password -s agentfund-agent-token -w`. |
| Output | `journalctl --user -u agentfund-<slug>.service -f` | `~/.local/share/agentfund/daemon/worker.log` |
| While logged out | `loginctl enable-linger $USER` | — |

## 5. The policy file

`~/.config/agentfund/config.yaml` is created by `approve` with a comment on every knob. It is
yours to edit. The worker enforces it, and nothing a server or repository says can loosen it.
Token amounts accept plain integers or `k`/`m`/`g` suffixes in either case (`750k`, `5M`,
`200m`); `0` means no cap.

| Knob (`global:`) | Default | What it protects |
| --- | --- | --- |
| `tokens_per_day` | `10m` | Your spend per local calendar day, across all projects. |
| `tokens_per_week` | `40m` | Same, Monday 00:00 to Monday 00:00 local time. |
| `max_tokens_per_task` | `5m` | Refuses any manifest whose `max_tokens` is higher. One runaway task cannot eat the day. |
| `new_project_max_tokens_per_task` | `5m` | Ceiling while the server reports the project's trust tier as `new` (no merge history). The worker takes the minimum of this, your task ceiling and the server's published cap. |
| `schedule` | `[]` (any time) | When new tasks may start, e.g. `["02:00-06:00"]`. Windows may wrap midnight. |
| `max_concurrent` | `1` | How many sandboxes run at once (1 to 16). |
| `allowed_git_hosts` | `["github.com"]` | Hosts the worker may clone from and publish to. A claim for a repository elsewhere is released. The entry `file` allows `file://` URLs, for tests. |
| `follow_unchanged_lock` | `false` | See [below](#when-the-projects-commit-moves). |
| `auto_follow_signed_updates` | `false` | See [below](#when-the-projects-commit-moves). |
| `retry_failed_after` | `"24h"` | After a task failed, timed out, hit its cap or was discarded here, do not claim it again for this long. Stops you paying for the same failure repeatedly. `"0"` retries immediately. |
| `claude_token_command` | `""` | Shell command printing a Claude Code OAuth token, used only when neither credential variable is set. |
| `sandbox.image`, `sandbox.egress_proxy_image` | The images this binary was released with, by digest (`agentfund version`); from source, `agentfund/sandbox:dev`, `agentfund/egress-proxy:dev` | What runs. If you set your own, pin it by digest (`name@sha256:...`): a tag can be re-pointed. |
| `sandbox.cpus`, `memory`, `pids` | `"2"`, `"4g"`, `512` | Your machine's resources. |
| `sandbox.allow_git_host` | `false` | By default the sandbox reaches only `api.anthropic.com`. `true` adds the project's git host. Leave it off: the sandbox has no `.git` and no git credentials, and every extra host is another place a hostile prompt could send data. |
| `sandbox.extra_allow_hosts` | `[]` | Further `host[:port]` entries for the proxy. Same warning. |
| `sandbox.pass_env` | `[]` | Names of extra environment variables passed to the agent (e.g. `ANTHROPIC_BASE_URL`). Their hosts are unreachable unless also allow-listed. |
| `sandbox.docker` | `"docker"` | Docker CLI binary. |
| `runner.name`, `runner.model` | `"claude-code"`, `""` | `claude-code` or `codex` (experimental: it reports usage only when it finishes, so a run can end above `max_tokens`; see [runners.md](runners.md)). `model` is passed as `--model`; empty uses the CLI's default, which for Claude Code 2.1.289 is an Opus model. Budgets count tokens, not dollars, so set a cheaper model if cost matters. |
| `runner.token_command` | `""` | Like `claude_token_command`, for whichever runner is configured; for `codex` its output is passed as `CODEX_API_KEY`. Empty with `claude-code` falls back to `claude_token_command`. |

**Reservation.** A task's full `max_tokens` is reserved against every cap before it starts and
settled to the real figure afterwards, so caps cannot be overshot. The accounting lives in
`~/.local/share/agentfund/state.json` and survives restarts. A consequence: with the default
10m/day and 2m to 4m tasks, the worker stops starting tasks once the *remaining* budget is
smaller than the next task's cap.

**Per-project overrides.** Under `projects:` each entry may also set `tokens_per_day`,
`tokens_per_week`, `max_tokens_per_task`, `schedule`, the two follow policies, and
`api_key_env`. Project token caps apply in addition to the global ones, and a project task
ceiling can only tighten the global one.

| Environment variable | Effect |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | The agent's credentials ([section 7](#7-whose-credentials-whose-bill)). |
| `AGENTFUND_API_KEY` | Server key (`af_...`), used instead of `credentials.yaml`. A project's `api_key_env` names another variable and wins over this one. |
| `AGENTFUND_CONFIG_DIR` | Config directory. Otherwise `$XDG_CONFIG_HOME/agentfund`, then `~/.config/agentfund`. |
| `AGENTFUND_DATA_DIR` | State directory. Otherwise `$XDG_DATA_HOME/agentfund`, then `~/.local/share/agentfund`. |
| `AGENTFUND_SANDBOX_IMAGE`, `AGENTFUND_EGRESS_PROXY_IMAGE` | Image overrides. The `work` flags win over these; these win over the config. |

### When the project's commit moves

Your approval covers one commit and its ancestors. Projects move: by default an instance
advances its pin to the head of the base branch whenever that head carries a valid signature,
which includes every time a task's pull request merges.

Before claiming, the worker fetches the repository and checks that the task's commit is
covered by your approval. When it is not, nothing is claimed, nothing runs, no tokens are
spent and nothing is reported. `dry-run` and `status` say the same, and `work --once` exits `3`:

```
agentfund: no task could be started: project moved to c7ade8975a42; run `agentfund approve http://localhost:8787/hello` to review and approve it
```

The check runs again against the commit the claim actually names; a claim that slips past it
is reported `verification_failed`. Re-approving also clears the `retry_failed_after` cooldown
of that project's earlier failed runs. You have three choices:

| Choice | What you are trusting |
| --- | --- |
| Re-run `agentfund approve` after each move (default) | Nothing new. You re-read the task set every time. On an active project this means after every merge. |
| `follow_unchanged_lock: true` (what `approve` asks about; stored per project) | That code changes between commits are fine as long as `tasks/MANIFEST.lock` is **byte-identical** to the one you approved: same prompts, same scopes, same verify commands. A new or edited manifest still needs your approval. This is the practical setting for a project you want to keep backing. |
| `auto_follow_signed_updates: true` | The maintainer's key, completely. |

> [!WARNING]
> With `auto_follow_signed_updates: true`, any task set validly signed by your pinned key runs
> **without you reading it**.

Both are off by default: each trades review for convenience, and that trade is yours to make.
`follow_unchanged_lock` has its own gap. The prompts are unchanged, but the repository around
them is not, and `verify` runs scripts from that repository inside the sandbox. The sandbox
is what limits them, not your review.

## 6. What the sandbox does and does not protect

| It does | How |
| --- | --- |
| **No host mounts** | No bind mounts and no Docker socket. The repository is streamed into a Docker volume as a tar built on the host from git objects: no `.git`, no `tasks/`, no `agentfund.yaml`. |
| **Non-root, no capabilities** | The agent and `verify` run as uid 10001 with `--cap-drop ALL`, `no-new-privileges`, a read-only root file system, tmpfs `/tmp` and home, and CPU, memory and process limits. Only files matching `scope.write` are writable in the work tree. |
| **One way out** | The container sits on a Docker `--internal` network with no route and no external DNS. The only other thing on it is the egress proxy, which accepts HTTPS `CONNECT` to an exact `host:port` allow-list (by default `api.anthropic.com:443` and nothing else) and refuses IP literals and names that resolve to private, loopback, link-local or metadata addresses. Every allow and deny is in your run log. |
| **Scope check on the host** | After `verify`, the work tree is streamed out as a tar and read in memory, never extracted. The whole run is discarded if anything changed outside `scope.write`, if `agentfund.yaml`, `tasks/**` or `.github/**` was touched, if there is a symlink, hard link, device or FIFO, if a file exceeds 5 MB or the change 50 MB, or if the change contains the credential the agent was given. |
| **Git credentials stay outside** | The commit is assembled on the host from that data and pushed with your `gh` session. The sandbox never sees your SSH keys, your `gh` token or any of your files. |
| **Bounded spend** | The sandbox is killed at the task's `max_tokens` or `timeout_minutes`. |

| It does not | Why, and what to do |
| --- | --- |
| **Act as a hypervisor** | The container shares your kernel. A kernel or container runtime vulnerability could let code escape. If that matters to you, run the worker in a VM or on a dedicated machine; rootless Docker reduces the impact further. |
| **Inspect content** | The proxy decides where the sandbox may connect, not what is sent, and it does not check the TLS server name inside the tunnel. |
| **Rule out exfiltration to an allow-listed host** | The agent's credential is in the environment of a process executing someone else's prompt, and that process can talk to the model API. In reach: the public repository and that credential, nothing else of yours. Mitigations: you read the prompts; they cannot change without your re-approval unless you enabled a follow policy; the default allow-list is one host; use a dedicated, revocable credential. |
| **Judge the work** | `verify` and CI decide whether a change is good. The scope check only decides where it may be. The pull request is a proposal for a human to review. |
| **Vet the images** | Build them yourself or pin digests. |
| **Hide the repository from the model provider** | The agent reads it; that is how it works. |

Full threat model: [SECURITY.md](SECURITY.md).

## 7. Whose credentials, whose bill

- The worker runs the unmodified Claude Code CLI, published by Anthropic, inside the sandbox
  image. It does not change or restrict how that CLI authenticates.
- The agent authenticates as **you**, with whichever of `CLAUDE_CODE_OAUTH_TOKEN` and
  `ANTHROPIC_API_KEY` is set (both are forwarded if both are set; the CLI chooses).
- AgentFund never collects, stores or relays these credentials. They are read from your
  environment at run time and handed to the container process: not in argv, not in an image,
  not in a config file, not in logs or reports, never sent to an AgentFund server.
- Usage is metered and billed to you under your own agreement with your provider. The
  project, the instance and its operators pay nothing and receive no credential.
- Whether running donated tasks fits the plan you have is your decision to make from your
  provider's terms. This project makes no claim on any provider's behalf about what those
  terms permit. Anthropic's Claude Code documentation says advertised usage limits for Pro and
  Max plans "assume ordinary, individual usage of Claude Code and the Agent SDK". Read them
  yourself:
  [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  [Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
  [Usage Policy](https://www.anthropic.com/legal/aup).
  An API key (`ANTHROPIC_API_KEY`, pay-as-you-go under Anthropic's Commercial Terms) is the
  unambiguous option. See also limitation 3 in [SECURITY.md](SECURITY.md).

## 8. Reading your own logs

```sh
agentfund logs                       # list: time, claim id, path (newest first)
agentfund logs clm_8f3a              # print one run (a unique part of the id is enough)
agentfund logs clm_8f3a --report     # the digest, the report that was sent, the server's answer
agentfund logs clm_8f3a --path       # just the file path
agentfund logs clm_8f3a | jq -r 'select(.kind=="prompt").prompt'
agentfund logs clm_8f3a | jq -c 'select(.kind=="egress").event'
```

Files live in `~/.local/share/agentfund/logs/<date>/<claim>.log` (mode 0600), one JSON object
per line with a `kind`: `claim`, `fetch`, `verification`, `manifest`, `prompt` (the exact text
given to the agent), `policy`, `sandbox` (images and the egress allow-list), `agent` (every
stream event from the CLI), `agent_stderr`, `agent_exit`, `verify` (command, exit code,
output), `egress` (proxy allow/deny lines), `scope`, `diff` (each changed file with its
content), `publish`, `published`, `outcome`, plus `phase` and `heartbeat` bookkeeping. Your
agent credential is scrubbed from every line.

**What `log_digest` proves.** The report sent to the server carries `log_digest`: the SHA-256
of the log file at the moment the report was built. After that the file is frozen. Recompute
it and compare it with the public report:

```sh
shasum -a 256 "$(agentfund logs clm_8f3a --path)"
agentfund logs clm_8f3a --report | jq -r .log_digest
```

Equal digests prove that the log on your disk is the one you committed to when you reported:
if you later publish it, anyone can check you did not edit it afterwards. It proves nothing
to anyone who has not seen the file, and it is not evidence that the run was honest. That is
what CI is for. The pull request body does not carry a digest; it points to the run's report
on the instance (`<server-url>/v1/tasks/<slug>:<task-id>`), where `log_digest` is published.

## 9. What the ledger columns mean for you

| Column | Counts | Whose word |
| --- | --- | --- |
| pledged | What you said you intend to give. | Yours. |
| reported | `tokens_in + tokens_out` of every run you reported or released, **including failed ones**. | Your worker's. |
| delivered | Tokens of completed runs whose branch passed the project's CI. | The CI provider's. |
| merged | Delivered tokens whose pull request was merged. | The git host's. |

- `tokens_in` includes cache-creation and cache-read tokens, so the figure is larger than
  "fresh" input and does not map linearly to cost.
- Leaderboards and your public profile rank on **delivered**.
- Failed runs are visible as `reported − delivered`, on your profile and the project's. They
  are never hidden and never counted as delivered.
- If CI passes and the maintainer later closes the pull request, your tokens stay delivered
  and are never counted as merged; the task reopens for someone else.
- Until CI reports, a completed run waits. On GitHub, a maintainer may first have to approve
  the workflow run for a first-time contributor.

## 10. Rate limits and backoff

**Your model provider.** When the CLI signals a rate limit or overload, the worker tears the
sandbox down, releases the claim with the tokens burned so far, and backs off: 5 minutes,
doubling per consecutive hit up to 4 hours, with jitter, never ending before the reset time
the provider gave. Nothing is claimed until it ends. The same happens when the agent never
reaches the model API at all (your network, DNS or a firewall): the claim is released, not
failed, so the task does not count against you. `agentfund status` shows
`Backing off until ... after a rate limit` (or `after the model API was unreachable`). One
clean agent run clears it. If the provider rejects your credentials or account, the claim is
released and the worker **stops**.

**The instance.** Servers limit requests per IP and per key (reference default 600 a minute)
and answer `429`. The worker's polling stays far below that; a refused request shows up as an
idle reason and is retried on the next poll. Instances also cap active claims per donor
(default 3).

## 11. Troubleshooting

Messages are quoted from the worker. `<...>` varies. More questions: [FAQ](faq.md).

| You see | Meaning | Do |
| --- | --- | --- |
| `no credentials for the coding agent: set CLAUDE_CODE_OAUTH_TOKEN ...` | Neither variable is set and there is no `claude_token_command`. | Export one in the shell (or env file) that runs `work`. |
| `the model provider rejected your credentials or account (<why>); fix them and start the worker again` | Expired or revoked token, billing or organisation problem. The worker has stopped. | Fix the credential. If an OAuth token is valid but still rejected, try adding `platform.claude.com` to `sandbox.extra_allow_hosts` (untested; see `CLAUDE_CODE_NOTES.md`). |
| `docker is not available: ...` | The daemon is not running or `docker` is not on `PATH`. | Start Docker; under launchd check the unit's `PATH`. |
| `container image <ref> is not present locally. From a checkout of the repository, build both images with make -C worker images; ...` | Sandbox or proxy image missing. | `make -C worker images`. |
| `no API key for <server>: run agentfund login ...` | Not logged in to that instance. | `agentfund login <server>`. |
| `project <ref> is not approved; run agentfund approve ...` | No approval record. | Approve it. |
| `git host "<h>" ... is not in allowed_git_hosts` | The repository is not on a host you allowed. | Add it only if you trust it. Only github.com can be published to. |
| `the key in the repository's agentfund.yaml and the key the server publishes DIFFER ...` | The two key channels disagree. One is wrong or compromised. | Do not approve. Ask the maintainer out of band; then `--pubkey`. |
| outcome `verification_failed`: `REFUSED — verification failed at step 2 (signature): lock signature does not verify against pinned key SHA256:...` | The lock at the claimed commit is not signed by the key you pinned (or a key it rotated to). | Stop and find out why. Do not re-approve a different key without confirmation from the maintainer. |
| `... at step 3 (content): manifest <path> hashes to <x> but the lock says <y>` (or `claim names content hash ...`) | Repository and lock disagree, or the server named a hash the signed lock does not contain. | Nothing ran. Tell the maintainer or the operator. |
| `idle: project moved to <sha>; run agentfund approve <ref> to review and approve it` (also in `dry-run` and `status`; `work --once` exits `3`) | The project moved past your approval. Nothing was claimed. | Re-approve, or see [follow policies](#when-the-projects-commit-moves). |
| `... at step 4 (approval): commit <c> is not the approved commit ...` | The pin moved between the pre-claim check and the claim. Reported `verification_failed`. | Re-approve (this also clears the retry cooldown). |
| outcome `released`: `donor policy: reserving <n> tokens would exceed global.tokens_per_day (<used> used of <cap>) — change it in <config path> ...` | Your cap. The message names the setting: `global.tokens_per_week`, `global.max_tokens_per_task`, `global.new_project_max_tokens_per_task`, `this project's ...` overrides, the cap the server publishes, or `this run's --budget`. The claim is released. | Wait, or raise the cap deliberately. |
| `idle: <task> skipped: outside the configured schedule; next window opens in <d>` | Your schedule. | Wait. |
| `idle: <task> skipped: this task ended "<status>" here <d> ago; not retrying ...` | `retry_failed_after`. | Wait, or lower it. |
| `<task>: claim refused: task-not-open` | Another donor claimed it first. Normal. | Nothing. |
| `claim refused: dependencies-unmet` / `project-task-cap` / `project-daily-cap` / `claim-limit` / `project-not-active` | Server-side refusals: unmerged dependencies, new-project trust caps, your active-claim limit, a paused project. | Wait. |
| `the server says the claim is no longer active; aborting the run` | Your lease expired (machine asleep, network down) or was revoked. The run stops and is reported late; its tokens are listed but not counted. | Keep the machine awake and online during runs. |
| outcome `budget_exceeded`: `killed at max_tokens (<n>)` | The task needed more than its cap. | Not your fault. The maintainer should resize the task. |
| outcome `timeout`: `killed at timeout_minutes (<n>)` | Same, wall clock. | Same. |
| outcome `failed`: `verify command exited with code <n>` | The agent did not get the work to pass. | Read the `verify` event in the log. |
| outcome `failed`: `the agent changed nothing inside scope.write` | The agent finished without an in-scope change. | — |
| `DISCARDED — scope violation: "<path>": file outside scope.write was modified` (or `created`, `deleted`, `never-writable path ...`, `symlinks may not be created or changed`) | The agent stepped outside its lane. The run is thrown away and reported `verification_failed`. | Nothing; this is the check working. |
| `DISCARDED — the change set contains the donor's agent credential (<path>)` | Your token ended up in a changed file. | Revoke that credential, then read the prompt in the log. |
| outcome `failed`: `could not publish the branch: gh is not logged in to github.com ...` | `gh` has no session. Tokens were spent; the work is lost. | `gh auth login`, and check `gh auth status` before long sessions. |
| `the server did not accept the report (...); it is kept in <file>.report.json` | Network or server error after the run. | The report is on disk; the claim will expire server-side. |
| outcome `released`: `rate limited by the model provider: <msg>`, then `backing off until <time> after a rate limit` | Provider rate limit. | Wait; see [section 10](#10-rate-limits-and-backoff). |
| outcome `released`: `the model API was unreachable from the sandbox: <msg>`, then `backing off until <time> after the model API was unreachable` | The agent never got an answer from the model API: no network, DNS, or a firewall or TLS-inspecting proxy in the way. | Check your connection; the worker retries after the backoff. See [section 10](#10-rate-limits-and-backoff). |
| `removed <n> orphaned sandbox resource(s) from an earlier run` | Cleanup after a crash or power loss. | Nothing. |

## 12. Uninstalling

```sh
agentfund daemon uninstall --project gridrs --now   # once per installed service
rm "$(command -v agentfund)"
rm -rf ~/.config/agentfund          # config, approvals, server keys (and any signing keys!)
rm -rf ~/.local/share/agentfund     # repo cache, logs, accounting
docker image rm agentfund/sandbox:dev agentfund/egress-proxy:dev
```

If you set `AGENTFUND_CONFIG_DIR`, `AGENTFUND_DATA_DIR` or the XDG variables, the directories
are wherever those point. Then, outside your machine: revoke the API key in the instance's
Settings, revoke the Claude credential you dedicated to this if you no longer need it, and
delete the forks the worker created under your GitHub account once their pull requests are
closed. Your past reports remain in the instance's public, append-only ledger.
