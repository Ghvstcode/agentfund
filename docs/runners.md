# Coding agents (runners)

The worker drives one coding agent CLI per run, inside the sandbox, under the backer's own
credentials. Which one is a backer's choice (`runner.name` in `config.yaml`); maintainers do not
pick it and manifests do not name it. Each report records the runner and its version
(e.g. `claude-code/2.1.289`, `codex/0.167.0`), so a project can see what did the work.

| Runner | `runner.name` | Credentials | State |
| --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/headless) | `claude-code` (default) | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or `ANTHROPIC_API_KEY`; Bedrock, Vertex and gateways through `sandbox.pass_env` | Supported. Full loop proven with a mock agent; the real CLI was run in the sandbox up to the model API |
| [Codex](https://github.com/openai/codex) | `codex` | `CODEX_API_KEY` or `OPENAI_API_KEY` | **Experimental.** Runs in the sandbox; no run against the real API yet. See its caveats below |

Both CLIs are in the sandbox image (`images/sandbox/Dockerfile`, version-pinned). Try either
end to end with your own key:

```sh
ANTHROPIC_API_KEY=sk-ant-… make trial                  # Claude Code
RUNNER=codex OPENAI_API_KEY=sk-… make trial            # Codex
MODEL=sonnet ANTHROPIC_API_KEY=sk-ant-… make trial     # pick a model (passed as --model)
```

`make trial` starts a local instance with the signed sample project, runs one small task with the
real agent (capped at 1M tokens by its manifest), plays CI if `verify` passes, and leaves the
instance up for you to look at. Ctrl-C removes everything.

## Codex: what is different

Read [`worker/internal/runner/CODEX_NOTES.md`](../worker/internal/runner/CODEX_NOTES.md) for
the details and for what has and has not been verified. In short:

- **`max_tokens` is checked when the run ends, not during it.** `codex exec --json` reports
  token usage only when its turn completes, so the worker cannot stop it at the cap. A Codex
  run can end above a task's `max_tokens`; it is then recorded as having hit its cap, and its
  real usage is reported and counted against your daily and weekly caps. `timeout_minutes`
  still applies. With Claude Code the worker stops the agent at the cap.
- **API keys only.** ChatGPT-plan sign-in keeps its tokens in a file (`~/.codex/auth.json`);
  the worker passes environment variables into the sandbox, never files.
- **It never gives up on an unreachable API by itself.** The runner stops it after a few
  minutes of "waiting for network" instead of letting it run to the task's timeout.
- **It tries to reach `chatgpt.com`** even with an API key. The egress proxy refuses that; the
  allowlist is `api.openai.com` only. Background features (plugins, apps, updates, browser and
  computer use, analytics, feedback) are switched off for every run.

## Adding another agent

A runner is one Go type implementing `runner.Runner` (`worker/internal/runner/runner.go`): a
name, the API hosts for the egress allowlist, how to find credentials in the environment, and
`Run`, which executes the CLI through the sandbox and turns its output into an `Outcome` (tokens
in and out, cost if known, model, version, success or failure, rate limit, credential problem).
The pipeline does the rest: claim, verify, scope check, `verify`, publishing and the ledger.
`claudecode.go` and `codex.go` are the two examples; register the new one in `runner.New` and
`config.Runners`, install the CLI in the sandbox image, and add a `*_NOTES.md` that says what
was verified and how.

An agent CLI fits when it has:

1. **A headless mode**: a prompt in, the agent works, it exits with a meaningful status. Prompt
   on stdin, not in argv.
2. **Machine-readable output with token usage**, ideally while it runs (that is what lets the
   worker enforce `max_tokens` mid-run), at least at the end. Without usage numbers there is
   nothing honest to put in the ledger.
3. **A way to skip every approval prompt**, because nobody is there to answer. The AgentFund
   sandbox (read-only root, scoped work tree, egress allowlist, no git credentials) is the
   boundary, not the agent's own permission system.
4. **Credentials from environment variables** and a short, known list of API hosts.
5. **No reliance on files or settings in the repository it works on**, or a flag to ignore them.

### Candidates

Not implemented. What follows is from each project's public documentation, **not verified**
against the CLIs; check each point with the real binary before relying on it.

| Agent | Headless + JSON | Usage while running? | Notes |
| --- | --- | --- | --- |
| Gemini CLI | `gemini -p` with JSON / stream-JSON output | To check | Google AI Studio key or Vertex. Qwen Code is a fork with the same shape |
| Cursor CLI | `cursor-agent -p` with stream-JSON output | To check | Cursor account key; models from several providers |
| opencode | `opencode run` with JSON output | To check | Many providers through one CLI; hosts depend on the provider chosen |
| GitHub Copilot CLI | `copilot -p` | To check | GitHub token; usage counted in requests rather than tokens may not fit the ledger |
| Amp, Goose, Aider | Headless modes exist | Unclear | Aider prints cost but has no structured event stream; the others to check |

The interfaces for other git hosts (`GitHost`) and CI systems (`CiAdapter`) work the same way;
see [decisions.md](decisions.md).
