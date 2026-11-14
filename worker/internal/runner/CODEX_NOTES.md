# Codex headless facts this package relies on

**Status: experimental.** Checked on 2026-11-08 against the installed CLI
(`codex-cli` 0.167.0 from npm `@openai/codex`): `codex exec --help`,
`codex login --help`, `codex features list`, the strings in the binary, the
openai/codex source at `rust-v0.167.0`, and runs inside the AgentFund sandbox
with a fake key or fake ChatGPT tokens. **First real run 2026-11-10**: a ChatGPT
Plus sign-in (`runner.codex_home`), `RUNNER=codex make trial`, task
`0001-slugify`: completed in 32 s, 73,048 tokens in / 750 out, `verify` and CI
passed, merged. Its stream is `testdata/codex-0.167.0-chatgpt-task.jsonl`
(`TestCodexMeterOnRealChatGPTStream`). **No run with a real API key or access
token yet.** Everything still marked *not verified* below is open. Re-verify
when bumping `CODEX_VERSION` in `images/sandbox/Dockerfile`.

## Invocation

```
codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
           --ephemeral --ignore-user-config --ignore-rules --color never \
           --disable plugins --disable remote_plugin --disable apps --disable in_app_updates \
           --disable browser_use --disable browser_use_external --disable in_app_browser \
           --disable computer_use -c analytics.enabled=false -c feedback.enabled=false \
           [--model M] -                                                   < prompt
```

| Flag | Why | Verified by |
| --- | --- | --- |
| `exec` | Non-interactive mode. | `--help`, sandbox run |
| `-` and prompt on **stdin** | `--help`: "If not provided as an argument (or if `-` is used), instructions are read from stdin". Same reasons as for Claude Code: verbatim, not in the process list. | `--help`; the sandbox run read it (the turn started) |
| `--json` | JSONL events on stdout. | `--help`, sandbox run |
| `--dangerously-bypass-approvals-and-sandbox` | Nobody can answer approval prompts, and Codex's own Landlock/seccomp sandbox needs privileges the unprivileged container does not have. `--help`: "Intended solely for running in environments that are externally sandboxed", which is what the AgentFund sandbox is. | `--help`; accepted in the sandbox run |
| `--skip-git-repo-check` | The sandbox work tree has no `.git`; without it `exec` refuses to start. | `--help`, sandbox run |
| `--ephemeral` | No session files. | `--help`; accepted |
| `--ignore-user-config`, `--ignore-rules` | No `config.toml`, no execpolicy `.rules`; auth still comes from the environment. | `--help`; accepted |
| `--disable <feature>` | Turns off features that call home or drive a browser or desktop. Names from `codex features list`. With them, the sandbox no longer tried `github.com` / `api.github.com`. | sandbox egress log, before and after |
| `-c analytics.enabled=false`, `-c feedback.enabled=false` | With them, `ab.chatgpt.com` was no longer contacted. | sandbox egress log, before and after |

## Credentials

Design and trade-offs: [docs/dev/codex-chatgpt-signin.md](../../../docs/dev/codex-chatgpt-signin.md).
Read from the 0.167.0 source (`codex-rs/login`) unless marked otherwise. In the order the runner
tries them:

1. `CODEX_API_KEY` / `OPENAI_API_KEY` from the environment, forwarded by name. Codex itself
   reads `CODEX_API_KEY` before anything else. *Not verified by execution:* that a real key
   authenticates `exec` without a prior `codex login`.
2. `CODEX_ACCESS_TOKEN` from the environment: a ChatGPT Business/Enterprise personal access
   token (`at-` prefix). Codex checks it once per process at
   `auth.openai.com/api/accounts/v1/user-auth-credential/whoami`, then sends model calls to
   `chatgpt.com/backend-api/codex`. Without the `at-` prefix Codex treats the value as an Agent
   Identity JWT and verifies it against OpenAI's JWKS, so an ordinary ChatGPT access token does
   **not** work there. *Not verified by execution.*
3. `runner.token_command`: output starting with `at-` goes in as `CODEX_ACCESS_TOKEN`, anything
   else as `CODEX_API_KEY`.
4. A ChatGPT sign-in in `runner.codex_home` (default `~/.config/agentfund/codex`, never
   `~/.codex`), made with `CODEX_HOME=<dir> npx -y @openai/codex@0.167.0 login` (same version as the image;
   `TestCodexCLIVersionMatchesTheSandboxImage` keeps them in step). Package `codexauth`:
   - before each run, under `flock(<dir>/auth.lock)` (the lock Codex takes), re-read
     `auth.json`; if the access token's `exp` is not after now + `timeout_minutes` + 10 min,
     POST `{client_id, grant_type: refresh_token, refresh_token}` as JSON to
     `https://auth.openai.com/oauth/token` (client id `app_EMoamEEZ73f0CkXaXp7hrann`, both
     copied from the Codex source, undocumented by OpenAI), and atomically replace `auth.json`
     (mode 0600, unknown fields kept, `last_refresh` updated). A login that recorded
     `oauth_provenance` refreshes at its own issuer with its own client id, like Codex.
   - Refresh tokens are **single-use**: reuse answers `refresh_token_reused`. That, `_expired`,
     `_invalidated`, or a 400/401 is reported as "sign in again" (claim released, worker stops).
   - The sandbox gets `~/.codex/auth.json` (home tmpfs, written by `sh -c 'umask 077 && cat >'`
     with the content on stdin) holding `auth_mode: chatgpt`, `id_token`, `access_token`,
     `account_id`, `refresh_token: ""` and `last_refresh: now`.
   - Why `last_refresh: now`: Codex refreshes before a request when the access token expires
     within 5 minutes or `last_refresh` is older than 8 days, and after a 401. It POSTs first and
     writes back afterwards, so a read-only `auth.json` would still rotate the token on the
     server and lose the new one. With no refresh token and `auth.openai.com` not allowlisted,
     a refresh cannot happen in the sandbox.
   - **Verified offline** (0.167.0, sandbox image, `--network none`, fake JWTs, the runner's
     flags): `codex login status` says "Logged in using ChatGPT"; `exec` starts the turn; no
     "Refreshing token" in the `RUST_LOG=info` output and the file is unchanged afterwards.
     Without the `--disable` flags it also tried `chatgpt.com/backend-api/ps/mcp`; with them it
     did not.
   - The id token lives 1 h and the worker refreshes on the access token's expiry only, so the
     sandbox normally gets an **expired id token**. Verified offline the same way: still "Logged
     in using ChatGPT", the turn starts, no refresh, file unchanged. In the 0.167.0 source the raw
     id token is only serialised back into `auth.json`, never sent upstream.
   - **Host refresh verified against the real endpoint** (2026-11-10, forced with
     `codexauth.Refresher.Fresh` on the Plus sign-in, using the recorded `oauth_provenance`):
     `auth.openai.com/oauth/token` answered with a new access token (240 h again), a new id
     token and a **rotated** refresh token; `auth.json` was rewritten with mode 0600,
     `last_refresh` moved, `oauth_provenance` and `login_owner_id` kept. The new access token
     works (`chatgpt.com/backend-api/codex/models`: HTTP 200). The backer's own Codex app
     (its sign-in in `~/.codex`) stayed signed in through the AgentFund login and this rotation
     (checked by the backer). Also seen: when the run needs longer than a fresh token
     lasts, the new tokens are saved first and `ErrTooShort` follows, so nothing is lost.

The access, id and refresh tokens are scrubbed from logs, and a change set that contains one is
discarded, as for every credential.

**A real sign-in** (Plus, 0.167.0 login, 2026-11-10; read from the JWT claims only): the
access token lives **240 h (10 days)**, `aud` `https://api.openai.com/v1`, `scp` `openid
profile email offline_access api.connectors.read api.connectors.invoke`; the id token lives
1 h and holds the name and email; `auth.json` also records `oauth_provenance` (issuer and client
id) and `login_owner_id`. So the worker refreshes about once every 10 days, and a stolen access
token works for up to 10 days.

**What a sandboxed task can take** (it runs as the same user as Codex): the API key or access
token, or the sign-in's access token and id token (name, email, account and user ids, plan
type). *Not verified:* which other `chatgpt.com` endpoints accept the access token.

## Network

| Credential | Allowlist |
| --- | --- |
| API key | `api.openai.com` |
| `CODEX_ACCESS_TOKEN` | `chatgpt.com`, `auth.openai.com` |
| Sign-in in `codex_home` | `chatgpt.com` (the worker refreshes on the host) |

Observed in the sandbox with a fake API key:

- `api.openai.com`: Responses API over WebSocket first, then HTTPS. A
  WebSocket inside a CONNECT tunnel passes the egress proxy unchanged.
- `chatgpt.com` (about 20 attempts per run): refused by the egress proxy and
  still there with the flags above. It did not stop the run from starting;
  *not verified* is whether it changes anything once the model answers.

Extra CAs (`sandbox.extra_ca_certs`), checked on 0.167.0 on 2026-11-10 with a fake key and
a local TLS server signed by a test CA:

- The HTTP client reads `CODEX_CA_CERTIFICATE`, else `SSL_CERT_FILE` (log line
  `codex_http_client::custom_ca: ... source_env="SSL_CERT_FILE"`), and with neither uses the
  system roots.
- The HTTP client *adds* that file to the public roots. With the test CA alone, under either
  variable, it still reached the real OpenAI endpoints and got a 401 for the fake key.
- The Responses WebSocket also honours `SSL_CERT_FILE`, but uses it *in place of* the roots.
  With the test CA alone it failed at `stage=Tls`. With `CODEX_CA_CERTIFICATE` it behaved as
  without any variable (`stage=Unknown`, the fake-key rejection).
- So the worker sets `SSL_CERT_FILE` to the image's roots plus the extra certificates
  (`/etc/agentfund/ca/bundle.pem`, 149 certificates in that run) and leaves
  `CODEX_CA_CERTIFICATE` unset. With that bundle the HTTP client got past TLS to the local
  server. Against the real endpoint the WebSocket was back to the baseline: `stage=Unknown`
  and three 401s, the same as without the variable.

With the ChatGPT sign-in (real run, 2026-11-10) the proxy log shows exactly 5 connections, all
to `chatgpt.com:443`, all allowed, nothing refused: no attempt at `auth.openai.com` or any other
host. The proxy sees hosts only, so what the 5 were (the model call, the models list, ...) is
not known. The stripped `auth.json` reached the sandbox through `docker exec` stdin, Codex used
it, and the host sign-in was not refreshed (its token was valid for 240 h).

## Events (`--json`)

Seen in sandbox runs: `thread.started`, `turn.started`, `error {message}`,
`item.completed {item: {type: "error"}}` (non-fatal, e.g. "Falling back from
WebSockets to HTTPS transport"). Seen in the real run: `item.started` /
`item.completed` with `agent_message`, `command_execution` and `file_change`
items, and one `turn.completed {usage: {input_tokens: 73048,
cached_input_tokens: 61824, cache_write_input_tokens: 0, output_tokens: 750,
reasoning_output_tokens: 0}}` as the last line. No stderr. `turn.failed {error: {message}}`
was seen in the rejected-token run (below).

Metering: `input_tokens` already includes `cached_input_tokens` (OpenAI
convention; the real run is consistent with it: cached 61,824 of 73,048), so
`tokens_in = input_tokens` and `tokens_out = output_tokens`; the usage of
every `turn.completed` is summed. *Not verified:* whether `output_tokens`
includes `reasoning_output_tokens` (OpenAI's convention; it was 0 here). The
stream does not name the model, so reports carry the configured `--model`
(empty by default).

**Usage arrives only when the turn ends.** Nothing in the stream reports
tokens while the agent works, so `max_tokens` is checked after the fact: a
Codex run can end above it. It is then recorded as having hit its cap, like a
Claude Code run that was stopped there, and the true usage is reported.
`timeout_minutes` still applies. Codex has a `token_budget` feature, but it
is listed as "under development" and is about compaction, so it is not used.

## Failure handling

| Condition | How it shows | Worker outcome |
| --- | --- | --- |
| API unreachable | `error` "Reconnecting... waiting for network" every 20 to 60 s, **forever**: the CLI never gives up on its own (seen: 200 s and counting). | The runner stops the agent after 4 in a row (65 s in the sandbox run, instead of the 20-minute timeout). If no item other than a CLI-side `error` item and no completed turn was seen, the model API never answered: the claim is **released** ("the model API was unreachable from the sandbox") and the worker backs off as for a rate limit; nothing is reported, so no 24 h retry cooldown. Going offline after the agent started working is an ordinary failure. Recorded stream: `testdata/codex-0.167.0-no-network.jsonl`; the release path is tested with the Claude Code mock (`unreachable` e2e image), *not run with the real Codex CLI*. |
| Rejected ChatGPT access token | **Seen 2026-11-10** (sign-in with a corrupted token signature; `testdata/codex-0.167.0-chatgpt-bad-token.*`). stderr: `401 Unauthorized: Could not parse your authentication token. Please try signing in again.` … `auth error code: invalid_jwt` from `chatgpt.com/backend-api/codex/models`. stdout: `error` "Reconnecting... n/5 (workspace routing discovery unauthorized (401))" twice five times (WebSocket, then HTTPS), then `turn.failed {error: {message: "workspace routing discovery unauthorized (401)"}}`, exit 1, after about 30 s, no tokens. Codex also tried `auth.openai.com` 16 times (refused by the proxy). Matched on `unauthorized (401)`, `invalid_jwt`, `try signing in again` as well as `401 Unauthorized`. | Released; the worker stops (credential problem). Verified end to end. |
| Bad API key | Matched on `401 Unauthorized`, `invalid_api_key`, `Incorrect API key`. *Not verified by execution.* | Released; the worker stops (credential problem). |
| No quota | `insufficient_quota`, "exceeded your current quota". *Not verified.* | Released; the worker stops (billing). |
| Rate or usage limit | `usage_limit_reached`, `429`, "rate limit". *Not verified* (for a ChatGPT plan this is the plan's Codex limit; not triggered on purpose). | Released; backoff. |
| Other `turn.failed` | Its message. | Failed. |

The version in reports (`codex/0.167.0`) comes from `codex --version`, run
before the agent, because the stream does not carry it.
