# Decisions made for you

The design left a number of choices open. Each one got a default instead of a blocker. This
page lists them, why, and where to change your mind.

| Decision | Default | Why | Change it |
| --- | --- | --- | --- |
| Name | `AgentFund`, binary `agentfund`. A working name | It had to be called something | `APP_NAME` (server and web), the `AppName` constant and GoReleaser's `project_name` (worker) |
| Demo project | `gridrs`, a std-only terminal spreadsheet in Rust | No dependencies means a sandbox with no registry access can build it | Any scoped repository with manifests |
| Coding agent | Claude Code only | One runner done properly; a `Runner` interface exists from day one | Implement `Runner` for another agent |
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

Money anywhere in the system. A ledger merged across instances. MicroVM isolation. An agent that decomposes your project
into manifests for you. Mobile apps. Analytics beyond the ledger.

## Federation: the choices

Five early decisions made it cheap: global ids are `<instance>/<slug>`, every instance has a
keypair in `/v1/meta`, ledgers are computed from evidence, capabilities are negotiated, and
reads need no authentication. On top of those, [federation](federation.md) made these calls:

| Choice | Default | Why, and how to change it |
| --- | --- | --- |
| Pull, not push | Each instance reads its peers' public API on a timer | No inbox to defend, no delivery queue, and an instance behind NAT can still follow others. `FEDERATION_SYNC_INTERVAL_SECONDS` |
| Peering is manual and one-directional | An admin adds each peer and confirms its key fingerprint | Trust is a decision, not a crawl. There is no peer-of-peer discovery |
| Listing a peer's projects ≠ admitting its donors | `discover` on, `accept_identities` off | The first costs nothing; the second makes their sign-up policy yours. Per peer, in Admin → Federation |
| Numbers from a peer are shown, never summed | Leaderboards and rank are local | An instance cannot check another's CI evidence, so it does not vouch for it |
| A federated donor is `handle@host` | `@` is not valid in a local handle | No collision with, or impersonation of, a local account is possible |
| Identity yields an API key, not a web session | Workers only | The worker is what needs to act elsewhere; a browser can just visit the other instance |
| A changed peer key stops everything | `key_mismatch` until an admin acts | Silent re-keying is exactly what an impostor would need |
| On unless switched off | `FEDERATION=true`, inert with no peers | Set `FEDERATION=false` to remove the capability |
