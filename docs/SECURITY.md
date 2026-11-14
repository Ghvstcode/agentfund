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
- email the address in the repository's `SECURITY` contact / the instance operator for
  instance-specific problems.

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
| Prompt injection exfiltrates repo or host data | No host mounts; the sandbox sits on an internal network whose only exit is a CONNECT-only proxy allowing `api.anthropic.com` (nothing else by default — not even the git host). IP literals and private/loopback/link-local/metadata addresses are refused. |
| Agent writes outside its lane (backdoor in an unrelated file) | The worker diffs the sandbox against the claimed commit on the host. Any path outside `scope.write`, any symlink or special file, or any change to `agentfund.yaml`, `tasks/**` or `.github/**` discards the whole run. |
| Budget burned on junk | Per-task `max_tokens` (kill at the cap) + donor daily/weekly caps + a per-task ceiling that refuses oversized manifests + schedule windows. |
| Credential theft | The Claude Code token is injected as an environment variable at container start only — never in an image layer, argv, log, or report. Git credentials never enter the sandbox: the worker pushes from the host. |
| Hostile PR content (CI abuse, malware in the diff) | Project side: CI on `pull_request` (never `pull_request_target`), no secrets on fork PRs, read-only token, pinned actions, human review before merge. See the maintainer guide. |
| A maintainer forges CI results for someone else's project | CI webhook secrets are per project; with polling enabled the server asks the CI provider itself and needs no secret at all. |
| Donor reports fake token numbers | Tokens count as **delivered** only when the CI provider confirms a passing run on the reported branch + commit. Leaderboards rank by delivered, never reported. |
| Sybil donors inflating leaderboards | GitHub identity + delivered-only ranking: inflation costs real tokens and real passing work. |
| New project farming trust | Per-task and per-day caps for projects with no merge history; they lift only with CI-passing merged work. Reputation is computed from the ledger. |
| A peer instance lies, or its key is stolen | A peer is added by an admin who confirms its key fingerprint, and the key is pinned. Its numbers are shown under its name and never added to a local total. Admitting its donors is a separate, off-by-default switch; an admitted donor still needs passing CI to count. A changed key quarantines the peer until an admin acts. See [Federation](federation.md). |
| Tampering with history | The `events` table is append-only (enforced in the database) and public; ledgers are computed from evidence rows, not stored totals. |

## Honest limitations

1. **Docker is not a hypervisor.** The sandbox isolates against untrusted code paths — it drops
   capabilities, runs non-root, has no host mounts and a filtered network — but a container
   escape (kernel or runtime bug) is out of scope for v1. This is why the system is scoped to
   open-source repositories with public task lists, not arbitrary compute. If that risk is not
   acceptable to you, run the worker inside a VM.
2. **The egress proxy does not inspect content.** It decides *where* the sandbox may connect,
   not *what* is sent. Data could in principle be sent to an allow-listed host — for example
   inside the prompts the agent sends to the model API. Only the checked-out public repository
   is in the sandbox, so there is nothing private to send unless you put it there. The proxy
   pins the IP an allow-listed name resolved to but does not check the TLS server name inside
   the tunnel, so domain fronting through a shared CDN edge is not ruled out; SNI pinning is a
   planned hardening.
3. **Your subscription's terms are between you and your AI provider.** The worker executes
   prompts under the donor's own login, on the donor's own machine. AgentFund makes no claim on
   any provider's behalf about what their terms permit. The worker runs the unmodified Claude
   Code CLI with whichever credential you already use (subscription login or your own API key),
   never stores or transmits it, and never intermediates your usage. Anthropic's documentation
   says subscription usage limits "assume ordinary, individual usage"; whether donating
   inference fits your plan is your call to make, and an API key is the unambiguous option.
   Read the terms:
   [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
   [Usage Policy](https://www.anthropic.com/legal/aup),
   [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
4. **A passing CI run is not a correctness proof.** `verify` and CI are as good as the tests the
   maintainer wrote. Merging remains a human decision.
5. **Model output is reviewed by nobody before CI runs it.** Maintainers must treat every
   AgentFund PR as an untrusted fork PR.

## Verifying things yourself

- Lock signature: `minisign -Vm tasks/MANIFEST.lock -P <pubkey from the project's Audit tab>`.
- What ran on your machine: `agentfund logs <claim>` — the full prompt, every agent event, the
  diff, and the report. `log_digest` in the public report is the SHA-256 of that file.
- What the instance claims: every delivered entry in `/v1/projects/<slug>/ledger` links the PR
  and the CI run that justified it.
