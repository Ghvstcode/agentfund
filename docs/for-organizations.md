# Running AgentFund for your organisation

Your company already pays for coding-agent seats, and most of them sit idle part of the week.
A private AgentFund instance lets your engineers point that idle time at the open-source code
you maintain or depend on. You choose the projects, every engineer sets their own caps, and the
ledger shows what was delivered and merged.

This page covers why you might run an instance yourself and how its settings map onto an
organisation. It also lists what v0.1 can't do yet. The commands for installing and running it
are in [Self-hosting](self-hosting.md).

## Why run it yourself

- **It's small.** One container serves the API, the web UI and the feeds. Its only dependency
  is Postgres 16+. The claim queue uses Postgres row locks and live updates use Postgres
  `LISTEN/NOTIFY`, so there's no queue, cache or worker fleet to run. The image is published
  at `ghcr.io/ghvstcode/agentfund`.
- **You don't have to trust the server, even your own.** Workers verify the maintainer's
  signature and every manifest hash on the engineer's machine. Someone who takes over the
  instance can hide tasks or show wrong numbers. They can't change what runs. The
  [threat model](SECURITY.md#threat-model) lists exactly what a compromised server can and
  can't do.
- **Agents run only on your engineers' machines.** The server never runs an agent and never
  sees a model credential or a git credential. Each task runs in a Docker sandbox with no host
  mounts. Its only way out is an egress proxy that, by default, allows the model API and
  nothing else.
- **It's Apache-2.0.** Fork it, rebrand it and run it without asking anyone.

## Two ways to run one

**For a community.** Run an instance for the projects you care about, with your own rules
about which projects get listed. Anyone with a GitHub account can sign in and back a project.

**Inside a company.** Run an instance for your engineers. It lists the public repositories
your company maintains, plus the open-source projects it depends on and wants to support.
Engineers give their spare quota to those tasks, and the ledger shows the result per project
and per person. The instance itself can sit behind your VPN (see
[Internal-only networking](#internal-only-networking)). The repositories still have to be
public. See [What v0.1 can't do](#what-v01-cant-do).

## How it maps onto an organisation

| You want | Set |
| --- | --- |
| Sign-in with your engineers' GitHub accounts | A GitHub OAuth app for the instance: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. Once both are set, dev login turns itself off. The server asks for `read:user user:email` only and drops the GitHub token after reading the profile. See [GitHub login](self-hosting.md#github-login). |
| Named admins | `ADMIN_HANDLES=alice,bob` (GitHub logins). If you leave it empty, the first user to sign in becomes the admin. |
| Nobody lists a project without review | In the admin UI, set project creation to **approval**. New projects then start `pending` until an admin activates them. Projects that an admin creates skip this. The default is **open**. Admins can also pause or remove a project at any time. |
| Your name on it | `INSTANCE_NAME` and `INSTANCE_DESCRIPTION` seed the instance's name and description on first boot. After that an admin edits them in the UI. The web UI's header and page titles show the instance name. `APP_NAME` renames the software in the API's `meta.app`, the server-rendered page titles and the Atom feed. A few places in the bundled UI still say AgentFund. `OG_ACCENT` sets the accent colour of the generated share cards. |
| Point engineers at your own docs and install line | `DOCS_URL`, `SOURCE_URL` and `INSTALL_COMMAND`. The default `INSTALL_COMMAND` builds the worker from source, so set it to the `install.sh` line from the [README](../README.md#back-a-project) if you want released binaries. |
| One webhook for all your repositories | Add an organisation-level GitHub webhook and set `WEBHOOK_SECRET` (16+ characters) to its secret. The instance accepts it for every project, alongside each project's own secret. It is never shown to maintainers. See [CI confirmation](self-hosting.md#ci-confirmation). |
| Limits on new projects and on each engineer | Instance settings in the admin UI: the per-task and per-day token caps for projects with no merge history, how many merged tasks make a project established, the lease length and how many claims one backer may hold at once. |

Each engineer's caps live on their own machine, in their worker's policy file. The defaults are
5M tokens per task, 10M per day and 40M per week. The instance can't raise them. See the
[donor guide](donors.md#5-the-policy-file).

## Internal-only networking

The instance doesn't have to be reachable from the internet. A typical setup puts it behind a
VPN:

- Set `CI_POLL=true`. The instance then asks the GitHub REST API for check runs and pull
  request state, so GitHub never has to reach it and no webhook is needed. Set `GITHUB_TOKEN`
  to raise the poller's rate limit from 60 requests an hour to 5,000. For public repositories
  it needs no scopes.
- The instance still needs **outbound** HTTPS to `github.com` and `api.github.com`: to clone
  the project repositories, to run the poller and to complete GitHub sign-in.
- GitHub sign-in still works. The OAuth callback is a browser redirect, so the instance only
  has to be reachable from the engineer's browser on the VPN.
- Workers need the instance (over the VPN), GitHub, to push branches and open pull requests, and
  the model API.

Two worker settings help on corporate networks. Both are covered in the donor guide:

- `sandbox.extra_ca_certs` lets the agent trust the CA of a TLS-inspecting proxy. See
  [Behind a TLS-inspecting proxy](donors.md#behind-a-tls-inspecting-proxy).
- `sandbox.pass_env` and `sandbox.extra_allow_hosts` let the agent use a model gateway, such
  as one set with `ANTHROPIC_BASE_URL`. Every extra host is another place a hostile prompt
  could send data, so add only what you need. See [Coding agents](runners.md).

## Subscription terms: what the organisation has to decide

Backers donate with their own coding-agent login. For Claude Code that's a subscription token
from `claude setup-token`, exported as `CLAUDE_CODE_OAUTH_TOKEN` on the machine that runs the
worker. The worker hands it to the unmodified Claude Code CLI inside the sandbox. It never
stores the token or sends it to the instance.

Whether donating fits a given plan is decided by that plan's terms, not by AgentFund. This
project makes no claim about what any provider's terms permit. Each backer is responsible for
their own plan. If the seats belong to the company, the company should check which agreement
covers them before it asks engineers to take part. Anthropic's documentation says subscription
usage limits "assume ordinary, individual usage". An API key is the unambiguous option, and
the worker accepts `ANTHROPIC_API_KEY` too. Read the terms yourself:
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and the
[Usage Policy](https://www.anthropic.com/legal/aup). [Whose credentials, whose
bill](donors.md#7-whose-credentials-whose-bill) in the donor guide has the details.

## What v0.1 can't do

- **Private repositories.** The server only indexes public repositories. Repository URLs must
  be `https://` on a public host name, and the server clones without credentials. This is a
  deliberate choice. Backers must be able to read every prompt before they approve a project,
  and the sandbox's safety argument rests on there being nothing private inside it (see the
  [FAQ](faq.md#can-it-work-on-a-private-repository)).
- **GitHub Enterprise Server and other git hosts.** CI polling talks to `api.github.com`, and
  repository hosts on internal domains are refused. Other CI systems can report results
  through the generic signed-JSON adapter ([Self-hosting](self-hosting.md#ci-confirmation)).
- **Several tasks at once per worker.** `max_concurrent` defaults to 1. Values up to 16 are
  accepted but haven't been exercised yet, so plan for one task at a time per worker.
- **Federation.** Instances are independent and don't share projects, backers or ledgers.
  Ids and keys are designed so instances can link up later
  ([Decisions](decisions.md#federation-what-was-decided-now-so-it-stays-possible-later)).
- **Docker is not a VM.** The sandbox drops capabilities, runs as non-root, has no host mounts
  and has a filtered network. A container escape through a kernel or runtime bug is still out
  of scope. If that matters to you, run workers inside a VM.
- **No TLS server-name pinning in the egress proxy.** The proxy pins the IP address that an
  allowed name resolved to. It doesn't check the TLS server name inside the tunnel, so domain
  fronting through a shared CDN edge isn't ruled out. See
  [SECURITY.md, honest limitations](SECURITY.md#honest-limitations).

## Next

- [Self-hosting](self-hosting.md): `docker compose`, every configuration variable, CI
  confirmation, reverse proxies, backups and upgrades.
- [Donor guide](donors.md): what each engineer installs and configures.
- [Maintainer guide](maintainers.md): writing tasks an agent can finish and CI can judge.
