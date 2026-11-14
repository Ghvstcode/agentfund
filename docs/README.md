# AgentFund documentation

Pick the line that describes you. Each path is in reading order and none is long.

| You want to | Read |
| --- | --- |
| **See it work** before reading anything | [Quickstart](quickstart.md): `make demo`, 30 seconds, zero tokens |
| **Understand it** | [Concepts](concepts.md), then [Security](SECURITY.md) |
| **Back a project** with your tokens | [Quickstart](quickstart.md) → [Donor guide](donors.md) → [Security](SECURITY.md) |
| **Fund your project** this way | [Quickstart](quickstart.md) → [Maintainer guide](maintainers.md) → [`examples/hello-project`](../examples/hello-project/) |
| **Run an instance** | [Self-hosting](self-hosting.md) → [Security](SECURITY.md) → [Federation](federation.md) |
| **Run one inside your company** | [For organisations](for-organizations.md) → [Self-hosting](self-hosting.md) |
| **Build a compatible worker, server or UI** | [`spec/manifest.md`](../spec/manifest.md) → [`spec/protocol.md`](../spec/protocol.md) → [`spec/openapi.yaml`](../spec/openapi.yaml) |
| **Change AgentFund itself** | [CONTRIBUTING](../CONTRIBUTING.md) → the README of the package you are touching |
| **Ask "but what about…"** | [FAQ](faq.md), then [Decisions](decisions.md) |

## Every document

| Document | What it is | Length |
| --- | --- | --- |
| [Quickstart](quickstart.md) | The zero-token local demo, then the same loop with a real agent | 5 min |
| [Concepts](concepts.md) | One task, followed from a YAML file to a ledger entry | 6 min |
| [Donor guide](donors.md) | Installing, approving, the policy file, the sandbox, your logs, troubleshooting | reference |
| [Maintainer guide](maintainers.md) | Decomposing a project into tasks, signing, keys, CI hardening, reviewing | reference |
| [Self-hosting](self-hosting.md) | `docker compose`, configuration, GitHub login, CI confirmation, backups | reference |
| [For organisations](for-organizations.md) | Running a private instance for a company or community: settings, networking, plan terms, limits | 5 min |
| [Federation](federation.md) | Peering instances: discovery, working elsewhere under your home identity, what a peer can and cannot do | 5 min |
| [Security](SECURITY.md) | The threat model, the honest limitations, how to report a vulnerability | 5 min |
| [FAQ](faq.md) | Plans and terms, cost, safety, fake numbers, failure, naming | 5 min |
| [Decisions](decisions.md) | The defaults we picked where the design left a choice, and how to change each | 3 min |

Package READMEs: [`worker/`](../worker/README.md) (the CLI), [`server/`](../server/README.md),
[`web/`](../web/README.md), [`spec/`](../spec/README.md),
[`images/sandbox/`](../images/sandbox/README.md), [`images/egress-proxy/`](../images/egress-proxy/README.md).

## Words we use

| Word | Means |
| --- | --- |
| **Backer**, **donor** | The same person: someone who runs the worker. The README says backer; the CLI, the API and the guides say donor. |
| **Maintainer** | Whoever holds a project's signing key. |
| **Instance** | One deployment of the server. Anyone can run one. |
| **Peer** | Another instance an admin chose to federate with, with its key pinned. |
| **Home** | The instance a donor's account lives on. Elsewhere they appear as `handle@home-host`. |
| **Manifest** | One task, as a YAML file under `tasks/` in the project's repository. |
| **Lock** | `tasks/MANIFEST.lock`: the SHA-256 of every manifest. The maintainer signs this one file. |
| **Approve**, **pin** | A donor reviewing a project once and recording its key, commit and lock hash locally. |
| **Claim** | A time-limited lease on one task, granted by the server to one worker. |
| **Reported / delivered / merged** | Tokens a worker says it spent / tokens whose pull request passed CI / tokens whose pull request merged. |

## Conventions

- Commands are meant to be pasted. `make check` verifies every relative link and every
  `agentfund` subcommand and flag these documents mention against the built CLI.
- `fund.example` stands for an instance's address, `gridrs` for a project's slug.
- When something has not been verified end to end, the document says so. The single source of
  truth for what is proven is the [Status section of the README](../README.md#status).

Working notes that explain how these documents came to look this way: [dev/readme-research.md](dev/readme-research.md).
