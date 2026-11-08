# Decisions made for you

The design left a number of choices open. Each one got a default instead of a blocker. This
page lists them, why, and where to change your mind.

| Decision | Default | Why | Change it |
| --- | --- | --- | --- |
| Name | `AgentFund`, binary `agentfund`. A working name | It had to be called something | `APP_NAME` (server and web), the `AppName` constant and GoReleaser's `project_name` (worker) |
| Demo project | `gridrs`, a std-only terminal spreadsheet in Rust | No dependencies means a sandbox with no registry access can build it | Any scoped repository with manifests |
| Coding agent | Claude Code by default; Codex experimental | One runner done properly first; the second (Codex) kept opt-in until a real run confirms it ([runners.md](runners.md)) | `runner.name`, or implement `Runner` for another agent |
| Git host and CI | GitHub only, plus a generic CI adapter that accepts signed JSON | `GitHost` and `CiAdapter` interfaces keep the rest possible | Implement the interfaces |
| Signature format | minisign: Ed25519, prehashed, detached `MANIFEST.lock.minisig` | Small, audited, and verifiable with a tool we did not write | A spec change (`lock_version`) |
| Following new commits | Off. A donor re-approves after every merge | The safe default is that nothing unreviewed runs | `approve` offers `follow_unchanged_lock` (accept new commits while the signed task list is byte-identical). `auto_follow_signed_updates` accepts any validly signed list. Both live in the donor's policy file |
| Sandbox egress | The model API only | The original design also allowed the git host. The sandbox has no `.git` and no git credentials, so that was only an exfiltration path | `sandbox.allow_git_host`, `sandbox.extra_allow_hosts` in the policy file |
| CI webhook secrets | One per project | A maintainer can then sign results only for their own project | Rotate from the Maintain page (`…/webhook/rotate`) |
| CI confirmation when GitHub cannot reach the instance | The server can also poll GitHub | A `localhost` instance still gets evidence from the provider itself | `CI_POLL` in the server's environment |
| Sandbox runtime | The Docker CLI, an internal network, a Rust CONNECT proxy as a sidecar | Every donor already has Docker | `sandbox.*` in the policy file |
| Ranking | Delivered tokens only | Reported is self-declared; pledged is intent | Not configurable. It is the point |
| New-project caps | 5M tokens per task and 25M per day until 3 tasks have merged | Reputation should cost passing, merged work | Instance settings, edited by an admin in the UI; see [Self-hosting](self-hosting.md) |

## Non-goals

Money anywhere in the system. Cross-instance features (see the roadmap in the
[README](../README.md#roadmap)). MicroVM isolation. An agent that decomposes your project
into manifests for you. Mobile apps. Analytics beyond the ledger.

## Federation: what was decided now so it stays possible later

Instances are independent islands today. Five cheap decisions keep the door open:

1. Global ids are `<instance>/<slug>`, never database ids.
2. Every instance has its own keypair, published in `/v1/meta`.
3. Ledgers are computed from evidence anyone can re-check, not from stored totals.
4. Capability flags in `/v1/meta` let clients negotiate.
5. Read endpoints need no authentication.

Cross-instance discovery, backing a project hosted on another instance and a portable donor
identity are roadmap, not code.
