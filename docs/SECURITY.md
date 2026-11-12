# Security

AgentFund asks people to run other people's prompts on their own machine, under their own AI
subscription. This document says exactly what protects them, what does not, and how to report
a problem.

Shorter versions of the same material: the trust table in the
[README](../README.md#why-you-can-trust-it), the walk-through in [Concepts](concepts.md), and
the questions in the [FAQ](faq.md). This is the full text.

## Reporting a vulnerability

Please report privately, not in a public issue:

- GitHub: **Security → Report a vulnerability** on this repository (private advisory), or
- email **mail@tobiokewole.com**.

A problem specific to one hosted instance (its configuration, not the software) goes to that
instance's operator.

Include what you found, how to reproduce it, and what an attacker gains. You will get an
acknowledgement within 3 working days and a fix-or-plan within 14. We credit reporters unless
asked not to. Please do not test against instances or projects you do not own.

In scope: the worker CLI, the sandbox and egress proxy, the signing/verification chain, the
server and its API, the web UI. Out of scope: container-escape bugs in Docker or the kernel
themselves (report those upstream — but tell us if AgentFund makes one easier to reach), and
the terms between a donor and their AI provider.

## The principle

**Trust the artifacts, not the operator.** Tasks are declarative manifests committed to the
project's git repository and covered by one maintainer signature. The worker verifies that
signature and every content hash itself, against a key and commit the donor personally
approved. The server only coordinates: it is untrusted middleware, and a compromised server
can stall work but cannot change what runs.

## What is being protected

The donor's **machine**, the donor's **AI subscription** (budget and credentials), and the
public's ability to **verify** every number the system shows.

## Threat model

| Threat | Defence |
| --- | --- |
| Server shows donors one task and feeds workers another | Signed `MANIFEST.lock` + per-manifest SHA-256, verified by the worker against the donor-pinned key. The server cannot alter work. |
| Malicious manifest added to the repo after approval | Approval pins a commit. Newer commits need re-approval, unless the donor opted into `follow_unchanged_lock` (byte-identical task set) or `auto_follow_signed_updates` (any validly signed set). Both default off. |
| Maintainer key swapped in the repo | The worker never reads the key from the repo at run time. The server UI shows the registered key's fingerprint as a second channel; rotation requires a statement signed by the old key. |
| Prompt injection exfiltrates repo or host data | No host mounts; the sandbox sits on an internal network whose only exit is a CONNECT-only proxy allowing the model API (`api.anthropic.com`; for Codex `api.openai.com`, or `chatgpt.com` with a ChatGPT credential) and nothing else by default — not even the git host. IP literals and private/loopback/link-local/metadata addresses are refused. |
| Agent writes outside its lane (backdoor in an unrelated file) | The worker diffs the sandbox against the claimed commit on the host. Any path outside `scope.write`, any symlink or special file, or any change to `agentfund.yaml`, `tasks/**` or `.github/**` discards the whole run. |
| Budget burned on junk | Per-task `max_tokens` (kill at the cap) + donor daily/weekly caps + a per-task ceiling that refuses oversized manifests + schedule windows. |
| A backer's extra CA (`sandbox.extra_ca_certs`) widens what the agent trusts | Off by default. The agent trusts that CA for TLS inside the sandbox, so whoever holds its key (the backer's network) can read and alter the agent's model traffic; that is already true of the backer's own machine on that network. Egress is unchanged: the proxy still allows only the same hosts. The worker copies in only `CERTIFICATE` blocks (a private key in the file is refused), into a root-owned directory the agent cannot write. |
| Credential theft | The agent's token is injected as an environment variable at container start only — never in an image layer, argv, log, or report. A Codex ChatGPT sign-in is the exception: it is a file, so the worker writes a copy into the sandbox's temporary home through stdin, **without the refresh token**, removes it when the agent exits (before `verify`), and keeps the refresh token on the host. Git credentials never enter the sandbox: the worker pushes from the host. Code in the sandbox can still read whichever credential the agent uses; see limitation 6. |
| Hostile PR content (CI abuse, malware in the diff) | Project side: CI on `pull_request` (never `pull_request_target`), no secrets on fork PRs, read-only token, pinned actions, human review before merge. See the maintainer guide. |
| A maintainer forges CI results for someone else's project | CI webhook secrets are per project; with polling enabled the server asks the CI provider itself and needs no secret at all. |
| Donor reports fake token numbers | Tokens count as **delivered** only when the CI provider confirms a passing run on the reported branch + commit. Leaderboards rank by delivered, never reported. |
| Sybil donors inflating leaderboards | GitHub identity + delivered-only ranking: inflation costs real tokens and real passing work. |
| New project farming trust | Per-task and per-day caps for projects with no merge history; they lift only with CI-passing merged work. Reputation is computed from the ledger. |
| A public page leaks a private project | Private repositories are readable only on a members-only instance (`INSTANCE_ACCESS=members`). There every API operation except sign-in, `/v1/meta` and the signed webhook needs a member's credential, pages carry no project data, and the sitemap, feed and OG cards are off. The server refuses to start with a GitHub App on a public instance. |
| Someone registers another person's project | On a public instance, preview and create ask GitHub, with the caller's own sign-in token, whether they can push to the repository, and refuse with `forbidden` otherwise. Only an admin can register a repository for someone else. The token (`read:user user:email`) is sealed on the session under a key derived from the session token, which the database stores only as a hash. |
| Preview used to read a private repository | Preview and create first check, through the GitHub App, that the caller can write to the repository. Every failure reads the same, so preview tells nobody that a repository exists. |
| The instance's GitHub App key is stolen | The app is read-only (Contents, Metadata, Checks, Pull requests; Members on the org) and installed on selected repositories. A thief can read those repositories, not change them. Tokens are minted per repository for one hour and kept in memory only. |
| A server tricks a backer into using their GitHub login elsewhere | The backer agrees per project, at `approve`, to fetch with `gh` (`git_auth: gh`); the server cannot set it. The credential helper is scoped to `https://github.com` and redirects are off. Pushing and opening PRs already used `gh` on the host; none of it enters the sandbox. |
| Tampering with history | The `events` table is append-only (enforced in the database) and public; ledgers are computed from evidence rows, not stored totals. |

## Honest limitations

1. **Docker is not a hypervisor.** The sandbox isolates against untrusted code paths — it drops
   capabilities, runs non-root, has no host mounts and a filtered network — but a container
   escape (kernel or runtime bug) is out of scope for v1. This is why the system is scoped to
   open-source repositories with public task lists, or to a members-only instance whose
   members trust each other's task lists about as much as their own codebase, not arbitrary
   compute. If that risk is not acceptable to you, run the worker inside a VM.
2. **The egress proxy does not inspect content.** It decides *where* the sandbox may connect,
   not *what* is sent. Data could in principle be sent to an allow-listed host — for example
   inside the prompts the agent sends to the model API. For a public project only the
   checked-out public repository is in the sandbox, so there is nothing private to send unless
   you put it there. For a private project the repository itself is private: see
   [Private repositories](#private-repositories). The proxy
   pins the IP an allow-listed name resolved to but does not check the TLS server name inside
   the tunnel, so domain fronting through a shared CDN edge is not ruled out; SNI pinning is a
   planned hardening. The proxy also cannot see tools that the model provider runs on its own
   side, such as web search: those reach the web from the provider, not from your machine. The
   worker therefore starts Claude Code with an allowlist of local tools only (shell, file
   reads and edits, sub-agents), which also keeps out the CLI's tools that schedule cloud agents
   on your account. For Codex this has not been verified yet. `chatgpt.com`, `api.openai.com` and
   `auth.openai.com` are served through Cloudflare (checked 2026-11-10), so the domain-fronting
   gap matters more for Codex with a ChatGPT credential (limitation 6).
3. **Your subscription's terms are between you and your AI provider.** The worker executes
   prompts under the donor's own login, on the donor's own machine. AgentFund makes no claim on
   any provider's behalf about what their terms permit. The worker runs the unmodified Claude
   Code CLI with whichever credential you already use (subscription login or your own API key),
   never stores or transmits it, and never intermediates your usage. Anthropic's documentation
   says subscription usage limits "assume ordinary, individual usage"; whether donating
   inference fits your plan is your call to make. AgentFund is built around subscription
   tokens (`claude setup-token`); the worker also accepts an API key if you would rather keep
   donated usage apart from your plan.
   Read the terms:
   [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
   [Usage Policy](https://www.anthropic.com/legal/aup),
   [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
   The same holds for Codex (experimental) and OpenAI: AgentFund makes no claim on OpenAI's
   behalf; whether donating usage fits your ChatGPT plan or workspace agreement is your call,
   and the worker also accepts an API key. Read
   [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/) and
   [Usage Policies](https://openai.com/policies/usage-policies/). One difference: a Codex
   ChatGPT sign-in is stored and renewed by the worker, in a directory used only by AgentFund
   (`runner.codex_home`), never in your own `~/.codex`.
4. **A passing CI run is not a correctness proof.** `verify` and CI are as good as the tests the
   maintainer wrote. Merging remains a human decision.
5. **Model output is reviewed by nobody before CI runs it.** Maintainers must treat every
   AgentFund PR as an untrusted fork PR.
6. **A hostile task can read the agent's credential.** The agent CLI and the commands it runs
   share one user in the sandbox, so whatever credential the agent uses is readable there. The
   worker refuses a change set that contains the credential literally, but an encoded copy in a
   diff, or one sent through the model API, is not detected. How much that matters depends on
   the credential: a Claude Code token or an API key can run model calls until revoked. A
   ChatGPT credential for Codex is broader: the sandbox must reach `chatgpt.com`, the proxy
   filters by host and not by path, and a sign-in's access token acts as your ChatGPT account
   until it expires (it cannot be renewed from the sandbox, because the refresh token stays on
   the host). A Business/Enterprise access token is limited to the scope and expiry you chose.
   See [Codex in the donor guide](donors.md#codex-experimental).

## Private repositories

On a members-only instance a project's repository can be private. Everything above still
holds, and three things change:

- **Private code goes to the model provider.** The agent reads the repository and sends what
  it needs to the model API under the backer's credential. That is the point of the feature,
  and it is a data-governance decision for the company: back private projects with
  **organization-managed** credentials (a Claude for Work or Enterprise seat, or an
  organization API key), not personal subscriptions. Codex with a personal ChatGPT sign-in is
  not recommended for private projects.
- **Limitation 2 now concerns real data.** A hostile task could try to move private code out
  through the model API, or through domain fronting at a shared CDN edge. The defences are the
  same: members review every prompt at `approve`, prompts cannot change without re-approval,
  and the default allowlist is one host.
- **The agent's branch lives in the repository itself.** A private repository usually cannot
  be forked, so the worker pushes `agentfund/…` straight to it, and only when the backer has
  write access. GitHub treats that pull request as coming from the same repository, so
  workflows on `pull_request` **do** get the repository's secrets. Keep secrets out of every job
  that runs on `agentfund/**` branches ([maintainer guide](maintainers.md#7-ci-hardening-checklist)).
  Public repositories keep the fork path even when the backer could push.

The server's side is described in
[Self-hosting](self-hosting.md#members-only-instance-private-repositories) and the design in
[docs/dev/private-repos.md](dev/private-repos.md).

## Verifying things yourself

- Lock signature: `minisign -Vm tasks/MANIFEST.lock -P <pubkey from the project's Audit tab>`.
- What ran on your machine: `agentfund logs <claim>` — the full prompt, every agent event, the
  diff, and the report. `log_digest` in the public report is the SHA-256 of that file.
- What the instance claims: every delivered entry in `/v1/projects/<slug>/ledger` links the PR
  and the CI run that justified it.
