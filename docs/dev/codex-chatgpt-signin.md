# Design: donating through Codex with a ChatGPT sign-in

**Status: approved 2026-11-10; (c1) and (c2) built** (`worker/internal/codexauth`,
`worker/internal/runner/codex.go`). What has been verified since is kept in
[CODEX_NOTES.md](../../worker/internal/runner/CODEX_NOTES.md), not here. Researched 2026-11-10
against Codex CLI 0.167.0, the version pinned in `images/sandbox/Dockerfile`. Sources:
`codex login --help` and `codex features list` in the sandbox image, the strings in the binary,
the openai/codex source at tag `rust-v0.167.0` (`codex-rs/login`, `cli`, `core`, `config`,
`protocol`), and OpenAI's [Codex authentication](https://developers.openai.com/codex/auth) and
[access tokens](https://developers.openai.com/codex/enterprise/access-tokens) pages. Anything
marked **to verify** has to be checked on the first real run.

The goal: a backer donates through Codex with their ChatGPT plan, the way a Claude backer
donates with `claude setup-token`, without needing an OpenAI API key.

## 1. How Codex authenticates (0.167.0)

Codex picks its credential in this order (`load_auth` in `login/src/auth/manager.rs`):

1. `CODEX_API_KEY` from the environment (API key; what the worker supports today).
2. In-memory "external" ChatGPT tokens. Only the app-server protocol (IDE extensions, the
   desktop app) can supply these; `codex exec` cannot.
3. `CODEX_ACCESS_TOKEN` from the environment:
   - with the `at-` prefix it is a **Codex personal access token** (PAT);
   - anything else is read as an *Agent Identity* JWT and checked against OpenAI's
     agent-identity JWKS. An ordinary ChatGPT login token fails that check, so this variable
     **cannot** carry a Plus/Pro login.
4. `$CODEX_HOME/auth.json` (default `~/.codex`). `codex login` writes it. The default store is
   `file`; `keyring`, `auto` and `ephemeral` are opt-in through `cli_auth_credentials_store`.

The answers to the questions in the brief:

| Question | Answer |
| --- | --- |
| A non-interactive token form? | **Only for ChatGPT Business and Enterprise:** a PAT in `CODEX_ACCESS_TOKEN`. Admins allow PATs, and members create them at `chatgpt.com/admin/access-tokens`. A PAT has a "Codex" scope and an expiry from 1 day to 90 days (or none, if the admin allows that), and it can be revoked at any time. `codex login --with-access-token` only stores the same token in `auth.json`. For **Plus and Pro there is no env-var form.** The only way in is `auth.json` from `codex login` (browser callback on `localhost:1455`) or `codex login --device-auth` (beta, must be enabled in ChatGPT's security settings first). |
| Which hosts? | Model calls with any ChatGPT credential go to **`chatgpt.com/backend-api/codex`**, not `api.openai.com` (`uses_codex_backend` is true for ChatGPT, PAT and agent-identity modes). Refresh goes to **`auth.openai.com/oauth/token`**. A PAT is checked once per process at **`auth.openai.com/api/accounts/v1/user-auth-credential/whoami`**. |
| When does it refresh? | Before a request: when the access token expires within **5 minutes**, or when `last_refresh` is older than **8 days**. Also after a 401. |
| Does exec write the file back? | **Yes.** It POSTs the refresh token, and only **after** the server answers does it write the new tokens back (`persist_tokens`: a `flock` on `$CODEX_HOME/auth.lock`, then compare-and-swap, then an atomic rename). **Refresh tokens are single-use:** reusing one fails with `refresh_token_reused`. |
| What if the file is read-only? | A trap, not a safety feature. The refresh still happens on the server, and that uses up the old refresh token. The write-back then fails with "credential file is read-only", so the new refresh token is lost, and every other copy of that login is dead on its next refresh. Codex logs the error and carries on with the old access token until it expires. |
| What does the login token allow? | `codex login` asks for the scopes `openid profile email offline_access api.connectors.read api.connectors.invoke`. The access token is a JWT that also carries the account's email, user and workspace IDs and plan type. **To verify:** its lifetime (`exp`), and whether it is accepted by other `chatgpt.com/backend-api` endpoints (chat history, memory) and by connected apps. Until that is shown otherwise, assume it can do anything the backer's ChatGPT web session can do. Claude's setup-token, by contrast, is inference-only. |
| Agent identity? | Behind the `use_agent_identity` feature, which is "under development" and **off by default** in 0.167.0. Nothing below relies on it. |

## 2. What changes compared with an API key, whatever the option

- **Allowlist:** `chatgpt.com` replaces `api.openai.com` (plus `auth.openai.com` for a PAT).
  The egress proxy filters by host, not by path. So a task can reach the **whole**
  `chatgpt.com` API with whatever token Codex holds, not only `/backend-api/codex`. Today about
  20 attempts to reach `chatgpt.com` per run are refused even with an API key; once it is
  allowed, they will succeed. **To verify:** what they are, and that the `--disable` flags
  keep plugins, apps and connectors off.
- **The task can read whatever Codex can read.** Codex and the task's shell commands both run
  as uid 10001 in the same container. An env var, a file in the home tmpfs and the memory of
  the Codex process are all equally readable by the task.
- **Ways out for a stolen token** are the existing ones (SECURITY.md limitation 2): an encoded
  copy in the diff (the change-set check only finds the literal secret), and domain fronting
  through a CDN edge, since `chatgpt.com` sits behind Cloudflare and the proxy does not yet pin
  SNI. A ChatGPT token is broader than a Claude one, so these limitations weigh more here.
  **Recommendation:** SNI pinning should land before ChatGPT sign-in leaves experimental.
- **Usage counts against the plan's Codex limits.** The refusal messages for "limit reached"
  differ from API-key quota errors (**to verify**; `codex.go` regexes to be fixed from a real
  stream).

## 3. Options

### (c1) Business/Enterprise: a PAT in `CODEX_ACCESS_TOKEN`. Recommended.

The closest thing to `claude setup-token`: env only, no file, nothing to refresh.

- **Worker change:** `Credentials` forwards `CODEX_ACCESS_TOKEN` (and adds it to `Secrets`).
  `APIHosts` becomes `chatgpt.com` + `auth.openai.com` for this credential. Runners have to be
  able to choose their hosts from the resolved credential (today `APIHosts()` is fixed per
  runner). No sandbox mount changes.
- **What a malicious task could steal:** the PAT, until it expires or the backer revokes it
  (the backer picks both). **To verify:** whether the "Codex" scope really keeps it off other
  `chatgpt.com` endpoints. Docs to recommend: a dedicated token, with the shortest expiry the
  backer will put up with.
- **Allowlist:** `chatgpt.com`, `auth.openai.com`. The whoami call needs the second host.
  Refresh never happens with a PAT.
- **Rotation races:** none. A PAT does not rotate, and the backer's own Codex is untouched.

### (c2) Plus/Pro: a dedicated AgentFund login, refreshed on the host, access token only in the sandbox. Recommended.

This is option (a) of the brief, done in the only form Codex accepts: a file, because there is
no env var for a ChatGPT access token.

1. **A separate login just for AgentFund.** The backer runs
   `CODEX_HOME=~/.config/agentfund/codex codex login` once. That is a separate OAuth session
   from their everyday `~/.codex` (**to verify:** that logging in twice gives two independent
   refresh chains). The worker refuses to use `~/.codex` itself. The config key is
   `runner.codex_home`, defaulting to the path above.
   - **This Mac:** `~/.codex/auth.json` already exists from the backer's own Codex. It is never
     read or copied.
   - `codex login` needs Codex on the host. **Open question:** do we also offer
     `codex login --device-auth` inside the sandbox image with that directory mounted, so the
     host needs nothing but Docker? It has to be enabled in ChatGPT settings first.
2. **The worker refreshes on the host, before each run, and only if needed.** It refreshes when
   the access token would expire before `timeout_minutes` + 10 minutes from now. It does this
   the way Codex does: a `flock` on `$CODEX_HOME/auth.lock`, re-read the file, POST to
   `https://auth.openai.com/oauth/token`, then an atomic write that keeps every field the
   worker does not know about. Credentials are therefore resolved per run, not once at
   `Prepare`.
   - **Trade-off to approve:** the worker then contains OpenAI's OAuth client ID
     (`app_EMoamEEZ73f0CkXaXp7hrann`, copied from Codex's source) and talks to an endpoint that
     is not documented. If OpenAI changes it, refresh breaks until we update; it fails closed
     with a clear message.
   - The alternative, driving a host `codex` to refresh, does not work: 0.167.0 has no
     subcommand that forces a refresh without a model turn.
3. **The sandbox gets a stripped `auth.json`.** Before `codex exec`, the worker writes
   `$HOME/.codex/auth.json` into the sandbox's home tmpfs. It goes through `exec` with the
   content on **stdin** (`umask 077; cat > …`), so it is never an argv, an image layer or a
   host mount. The file holds `auth_mode: chatgpt`, `id_token`, `access_token` and
   `account_id`, with **`refresh_token: ""`** and `last_refresh` set to now, so Codex has no
   reason to refresh and nothing to refresh with. The access token and id token go into
   `Secrets` for scrubbing. **To verify:** that exec accepts an empty refresh token (in the
   source, `codex doctor` only warns about it).
   - `--ignore-user-config` stays: it skips `config.toml`, not `auth.json`. **To verify** in
     the first run.

What follows from that design:

- **What a malicious task could steal:** one ChatGPT access token, valid until its `exp`
  (**to verify** at first login; it could be several days). It cannot mint more, because there
  is no refresh token in the sandbox and `auth.openai.com` is not allowlisted. Whether
  `codex logout` on the host (which revokes the refresh token) also kills access tokens already
  issued is **to verify**. The backer's email, user ID and plan type are also readable from the
  id token. That is a real widening compared with Claude, and the donor docs must say so
  plainly.
- **Allowlist:** `chatgpt.com` only. The host does the refresh, outside the sandbox.
- **Rotation races:** with the backer's everyday Codex, none, because it is a different login
  and a different file. Between two worker processes that share the dedicated home
  (`max_concurrent` > 1, or two `agentfund work`), the shared `flock` and the re-read-after-lock
  serialise them. Because the lock and format are Codex's own, a backer who runs `codex` with
  `CODEX_HOME` set to the AgentFund directory is also safe. If a refresh fails with
  `refresh_token_reused`, `_expired` or `_invalidated`, it is a credential problem: the claim is
  released, the worker stops, and it says to run `codex login` again.

### (b) A full per-run `auth.json` copy in a tmpfs, copied back afterwards. Rejected.

- **What a malicious task could steal:** the **refresh token**, and with it a ChatGPT session
  that keeps minting access tokens until the backer notices and revokes it. Rotation does not
  help, because the attacker can refresh first, and then the backer's copy is the one that dies.
- **Allowlist:** `chatgpt.com` + `auth.openai.com`. Refresh then runs inside the sandbox.
- **Rotation races:** Codex in the sandbox rotates the token on the server. If the run is
  killed (timeout, `max_tokens`, container crash) before the copy-back, the backer's login is
  dead. If the backer's own Codex shares the login, it is dead on its next refresh.
- It also needs a host mount or a copy-out step, both of which the brief asked to keep minimal.

### Considered and dropped

- **(a) as the brief wrote it, with only env vars:** not possible for Plus/Pro (§1, point 3).
  (c2) is the same idea with a stdin-written file.
- **Sharing the backer's `~/.codex`:** has the same races as (b), against their everyday tool.
- **Downscoping on refresh** (asking `oauth/token` for fewer scopes, e.g. without
  `api.connectors.*`): would narrow (c2) a lot if `auth.openai.com` honours it. Unknown and
  undocumented. It is worth one experiment during A2, and it is not part of the plan unless
  that works.

## 4. Terms

Docs wording, mirroring SECURITY.md limitation 3 and the FAQ. No legal claims:

> Your plan's terms are between you and OpenAI. AgentFund makes no claim on OpenAI's behalf
> about what they permit. The worker runs the unmodified Codex CLI under your own sign-in, on
> your own machine, never transmits the credential to AgentFund, and never intermediates your
> usage. Whether donating usage fits your ChatGPT plan is your call to make, and an API key is
> the unambiguous option. Read the terms yourself: [OpenAI Terms of
> Use](https://openai.com/policies/terms-of-use/), [Usage
> Policies](https://openai.com/policies/usage-policies/), and, for Business and Enterprise,
> your workspace agreement.

The wording is "never stores" for an API key or PAT, but **not** for (c2). There the worker
does store and rotate tokens, in the backer's dedicated `CODEX_HOME`, so the docs say exactly
that.

## 5. Build plan once approved

1. `runner`: `Credentials` per run (the pipeline calls it for each claim). `APIHosts` derived
   from the credential. `Codex` picks, in order: API key, then `CODEX_ACCESS_TOKEN`, then the
   dedicated `CODEX_HOME`. A small `codexauth` package does the read, lock, refresh and write
   for (c2), plus the stripped file. Tests: a fake token endpoint (refresh, reuse error,
   concurrent refresh under the lock), unknown fields kept, the stripped file holds no refresh
   token, `Secrets` hold both tokens, and the hosts for each mode.
2. Docs: `CODEX_NOTES.md`, `docs/runners.md`, `docs/donors.md`, `docs/faq.md`,
   `docs/SECURITY.md` (threat table row "Credential theft", limitations 2 and 3).
3. A2 against the real service, each run approved first: `make trial RUNNER=codex --once`, the
   smallest task, cost estimate first. Record the stream as a fixture with the email, IDs and
   plan removed. Try a revoked or expired credential on purpose. Fix the `codex.go` regexes
   from what really comes out.

## 6. Open questions for the user

1. **Which ChatGPT plan will A2 run on?** Plus/Pro means (c2). Business/Enterprise with PATs
   allowed means (c1), and (c2) would then be built but only tested with fakes. This decides
   what can be verified for real.
2. Approve (c1) + (c2), and the rejection of (b)?
3. Approve the worker refreshing with Codex's OAuth client ID against the undocumented
   `oauth/token` endpoint (§3, c2 step 2)?
4. Offer device-auth login inside the sandbox image, or require Codex on the host?
5. Should SNI pinning in the egress proxy block ChatGPT sign-in leaving experimental?
