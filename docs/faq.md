# FAQ

Short answers. Each one links to the place that proves it.

## Backing a project

### Is this allowed under my AI plan?

We make no claim on any provider's behalf about what their terms permit. What the worker does
is checkable: it runs the unmodified Claude Code CLI, on your machine, under the credential
you already use (a subscription login or your own API key). It never stores, transmits or
intermediates that credential or your usage.

Anthropic's documentation says subscription usage limits "assume ordinary, individual
usage". Whether donating inference fits your plan is your call to make, and an API key is the
unambiguous option. Read the terms yourself:
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Usage Policy](https://www.anthropic.com/legal/aup),
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
The careful version of this answer is limitation 3 in [Security](SECURITY.md).

### What does it cost me?

Tokens: against your subscription's limits, or on your API bill. AgentFund itself costs
nothing and no money moves through it.

You set the ceiling in four places, and your worker enforces all of them:

| Limit | Default | Where |
| --- | --- | --- |
| Per task | 5M tokens; larger manifests are refused | `max_tokens_per_task` in the policy file |
| Per day, per week | 10M, 40M | `tokens_per_day`, `tokens_per_week` |
| Per invocation | none | `agentfund work --budget 2m` |
| Time of day | any | `--schedule "02:00-06:00"` or the policy file |

Each manifest also carries its own `max_tokens`; the run is killed at the cap. For scale: the
tasks in the gridrs demo project are capped at 1.5M to 4M tokens each.

### What can the agent touch?

A copy of the project's public repository inside a container, and the model API. It has no
host mounts, runs as a non-root user, and its only network route is a proxy that allows the
model API and nothing else: not the git host, not a package registry. Your git credentials
never enter the container; the worker pushes from the host. If the agent changes anything
outside the task's declared write scope, the worker discards the whole run.

What that does not cover: a container escape. Docker is not a hypervisor. If that risk is
not acceptable, run the worker inside a VM. [Security](SECURITY.md) has the full list.

### Can the server make my machine run something else?

No. `agentfund approve` pins the maintainer's key and a commit in your own config. Before
every run the worker checks the signature and every hash against that pin, and refuses
anything that does not verify. The server can withhold work. It cannot change it.
[Concepts](concepts.md) lists the five checks.

### Does the server see my credentials or my code?

It sees your handle, your reports (token counts, the branch, the commit, a digest of your
log) and your pledges. It never receives your model credential or your git credential, and
the work is on a public repository to begin with.

### What happens if a task fails?

The tokens are spent and they stay visible: they count as *reported* and never as
*delivered*. The task reopens for someone else. By default your worker does not retry a task
it failed for 24 hours. A project full of tasks that burn tokens and fail shows exactly that
on its page, which is the point of keeping the column.

### Can I leave it running overnight?

Yes. `--schedule "02:00-06:00"` confines it to a window, the daily and weekly caps bound the
total, and `agentfund daemon install` writes a systemd user unit or a launchd agent. Start
with `--once` and read the log before you do.

### How do I see what actually ran?

`agentfund logs` lists runs; `agentfund logs <claim>` prints the full prompt, every agent
event, the verify output, the diff and the proxy's decisions. The SHA-256 of that file is in
the public report, so what you read is what was reported.

## Funding a project

### Why not just donate money?

Do that too. Money can hire a person, and some problems need a person. But money needs
payment rails, a fiscal host, and somebody to decide who gets paid, and most small projects
have none of those. Tokens need a repository and a test suite. A token donation also arrives
already converted into the thing you wanted: a pull request that passes your CI.

### Will the code be any good?

It will be exactly as good as your tests. `verify` and CI are the judge, and a passing run is
not a proof of correctness. You still review and merge every pull request. The
[Maintainer guide](maintainers.md) is mostly about writing tasks whose tests cannot be
satisfied by cheating.

### Do I have to change my CI?

You have to harden it, the same way you would for any pull request from a stranger's fork:
run on `pull_request`, never `pull_request_target`; no secrets on fork PRs; a read-only
token. The checklist is in the [Maintainer guide](maintainers.md).

### Can it work on a private repository?

It is not designed to. Donors must be able to read every prompt before approving, and the
safety argument for the sandbox rests on there being nothing private inside it.

### Will an agent break my project into tasks for me?

No, and that is a deliberate non-goal. Deciding what the project is, and what "done" means
for each piece, is the maintainer's part.

## The numbers

### What stops fake numbers?

A worker reports its own token count, so *reported* proves nothing, and nothing ranks on it.
Tokens become *delivered* only when the CI provider itself confirms a passing run on the
exact branch and commit that was reported. Leaderboards rank on delivered. To inflate your
standing you have to spend real tokens on work that really passes.

### What stops a maintainer faking CI for their own project?

Nothing stops a maintainer from writing a CI that always passes, and nothing could: their
repository, their CI. What the design does is keep it visible. A new project is capped
(5M tokens per task, 25M per day) until three of its tasks have merged, every delivered
entry links the pull request and the CI run, and the diff is public. A maintainer cannot
forge results for anyone else's project, because webhook secrets are per project.

### Can the instance operator edit the ledger?

They run the database, so they can show whatever they like on their own pages. They cannot
make it check out: totals are computed from evidence rows, each delivered entry links a pull
request and a CI run on someone else's infrastructure, and the event log is append-only in
the database. Compare the instance's story with GitHub's and a lie has to be told twice.

## The project

### What is proven and what is not?

The [Status section of the README](../README.md#status) is the one place that is kept
current. Short version: the full loop is proven against a mock agent in CI; the real GitHub
path is proven once by hand; a real model inside the sandbox has not been run yet.

### Which agents, models and git hosts?

Claude Code and GitHub. The worker has a `Runner` interface and the server has `GitHost` and
`CiAdapter` interfaces, plus a generic CI adapter that accepts a signed JSON result from any
CI system. Nothing else is implemented.

### Why Docker and not a microVM?

Because every donor already has Docker. MicroVM isolation is a non-goal for v1, and the
scope is narrowed to match: open-source repositories with public task lists, not arbitrary
compute. [Decisions](decisions.md) has the other defaults.

### Do instances talk to each other?

Only when their admins say so. An admin can peer with another instance: its projects are
then listed here, its donors can work here under their home identity if the admin allows it,
and profiles show work delivered elsewhere. Each instance still counts only its own
evidence; numbers from a peer are shown under the peer's name and never added up.
[Federation](federation.md) has the details.

### Why is it called AgentFund?

It is a working name. It lives behind one constant in the server and web UI and one in the
worker, so it can change before launch without a rewrite. [Decisions](decisions.md) says where.

### I found a security problem.

Please report it privately. [Security](SECURITY.md) says how.
