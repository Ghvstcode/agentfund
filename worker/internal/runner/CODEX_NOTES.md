# Codex headless facts this package relies on

**Status: experimental.** Checked on 2026-11-08 against the installed CLI
(`codex-cli` 0.167.0 from npm `@openai/codex`): `codex exec --help`,
`codex login --help`, `codex features list`, the strings in the binary, and
runs inside the AgentFund sandbox with a fake key. **No run against the real
OpenAI API has been made yet**: the build host could not reach
api.openai.com. Everything marked *not verified by execution* below must be
checked on the first real run (`RUNNER=codex make trial`). Re-verify when
bumping `CODEX_VERSION` in `images/sandbox/Dockerfile`.

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

`CODEX_API_KEY` or `OPENAI_API_KEY` from the environment (both names appear in
the binary), or the output of `runner.token_command`, forwarded as
`CODEX_API_KEY`. ChatGPT-plan sign-in stores tokens in `~/.codex/auth.json`;
the worker forwards environment variables only, never files, so it is not
supported. *Not verified by execution:* that a real key in either variable
authenticates `exec` without a prior `codex login`.

## Network

Allowlist: `api.openai.com:443` only. Observed in the sandbox with a fake key:

- `api.openai.com`: Responses API over WebSocket first, then HTTPS. A
  WebSocket inside a CONNECT tunnel passes the egress proxy unchanged.
- `chatgpt.com` (about 20 attempts per run): refused by the egress proxy and
  still there with the flags above. It did not stop the run from starting;
  *not verified* is whether it changes anything once the model answers.

## Events (`--json`)

Seen in sandbox runs: `thread.started`, `turn.started`, `error {message}`,
`item.completed {item: {type: "error"}}` (non-fatal, e.g. "Falling back from
WebSockets to HTTPS transport"). Present in the binary and relied on, *not
verified by execution*: `turn.completed {usage: {input_tokens,
cached_input_tokens, output_tokens}}` and `turn.failed {error: {message}}`.

Metering: `input_tokens` already includes `cached_input_tokens` (OpenAI
convention), so `tokens_in = input_tokens` and `tokens_out = output_tokens`;
the usage of every `turn.completed` is summed.

**Usage arrives only when the turn ends.** Nothing in the stream reports
tokens while the agent works, so `max_tokens` is checked after the fact: a
Codex run can end above it. It is then recorded as having hit its cap, like a
Claude Code run that was stopped there, and the true usage is reported.
`timeout_minutes` still applies. Codex has a `token_budget` feature, but it
is listed as "under development" and is about compaction, so it is not used.

## Failure handling

| Condition | How it shows | Worker outcome |
| --- | --- | --- |
| API unreachable | `error` "Reconnecting... waiting for network" every 20 to 60 s, **forever**: the CLI never gives up on its own (seen: 200 s and counting). | The runner stops the agent after 4 in a row; the attempt fails with "the model API is unreachable from the sandbox" (65 s in the sandbox run, instead of the 20-minute timeout). |
| Bad key | Matched on `401 Unauthorized`, `invalid_api_key`, `Incorrect API key`. *Not verified by execution.* | Released; the worker stops (credential problem). |
| No quota | `insufficient_quota`, "exceeded your current quota". *Not verified.* | Released; the worker stops (billing). |
| Rate or usage limit | `usage_limit_reached`, `429`, "rate limit". *Not verified.* | Released; backoff. |
| Other `turn.failed` | Its message. | Failed. |

The version in reports (`codex/0.167.0`) comes from `codex --version`, run
before the agent, because the stream does not carry it.
