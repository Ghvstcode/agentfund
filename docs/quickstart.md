# Quickstart

Two parts. First the whole loop on your machine with a mock agent, which costs nothing and
takes about 30 seconds once built. Then the same loop for real.

## Part 1: the zero-token demo

### What you need

| Tool | Why |
| --- | --- |
| Docker, running | Postgres, the sandbox and the egress proxy are containers |
| Node 22 and pnpm | The server and the web UI |
| Go 1.27+ | The `agentfund` CLI |
| git, curl, openssl | The sample repository, API calls, signing the stand-in CI result |

### Run it

```sh
git clone https://github.com/ghvstcode/agentfund && cd agentfund
make demo
```

`make demo` is `sh scripts/demo.sh`. It does four things and says so as it goes:

1. **Build.** Server, web UI, the worker binary, a sandbox image whose `claude` is a scripted
   mock, and the egress proxy.
2. **A signed project.** Copies [`examples/hello-project`](../examples/hello-project/) to
   `.demo/hello-project`, signs its three tasks, commits it. The instance and the worker
   reach it as a `file://` repository.
3. **An instance.** Postgres in Docker, the server on <http://localhost:8787>, a maintainer
   and a donor account, the project registered, three million tokens pledged.
4. **A backer's worker.** `approve`, then `work --once` twice. After each run the script plays
   the CI provider: it posts a passing result, signed with the project's webhook secret, then
   merges the branch.

Keep <http://localhost:8787/hello> open while step 4 runs. This is the end of a real run:

```console
$ agentfund work hello --once
22:21:20  working on http://localhost:8787/hello (file:///…/.demo/hello-project), up to 1 task(s) at a time
22:21:21  0001-slugify: running claude-code in the sandbox (max 1M tokens, 20 min)
0001-slugify: completed (8,100 in / 150 out tokens) — branch agentfund/0001-slugify-9u9q8anf pushed to file:///…/.demo/hello-project
  reported, not yet delivered
    pledged 3,000,000 · reported 8,250 · delivered 0 · merged 0
  CI passed on agentfund/0001-slugify-9u9q8anf
    pledged 3,000,000 · reported 8,250 · delivered 8,250 · merged 0
  merged into main; the indexer followed the signed head
    pledged 3,000,000 · reported 8,250 · delivered 8,250 · merged 8,250
```

Those three ledger lines are the product. Tokens show up as **reported** the moment the
worker says so, and that proves nothing. They become **delivered** when CI passes on the
exact commit that was pushed, and **merged** when the pull request lands.

On the machine this was written on, with images already built, the script printed
`Done in 27s`. The first run also builds two container images and takes longer; we have not
timed a cold run on a clean machine.

### What was real, and what was not

| Real | Mock |
| --- | --- |
| The server, its indexer, claim queue and ledger | The coding agent: a script that writes a known-good answer and reports made-up token counts |
| The `agentfund` binary, signature and hash verification, policy caps | The CI provider: `demo.sh` posts the result a CI system would |
| The Docker sandbox and the egress proxy | The git host: a local `file://` repository, so there is a branch but no pull request page |
| The scope check on the diff, the push, the report | |

### Look around

The script leaves the instance running and prints these:

```sh
. .demo/env                      # points agentfund at the demo's config and images
agentfund status                 # tokens against caps, recent runs
agentfund logs                   # one line per run; then: agentfund logs <claim>
git -C .demo/hello-project log --oneline --graph     # the two merged branches

# The signature, checked without our binary:
minisign -Vm .demo/hello-project/tasks/MANIFEST.lock \
  -P "$(sed -n 's/^pubkey: //p' .demo/hello-project/agentfund.yaml)"
```

In the browser: the **Audit** tab of <http://localhost:8787/hello> shows the same fingerprint
`approve` printed; <http://localhost:8787/u/donor> is the backer's public profile; sign in
as `maintainer` (dev login, any handle works) to see the maintainer's side.

`agentfund status` will tell you the project moved and ask you to approve again. That is the
pin doing its job: every merge is a new commit, and the worker runs only what you reviewed.
The demo opted in to `--follow-unchanged-lock`, which keeps working as long as the signed
task list is byte-identical.

Ctrl-C in the demo's terminal stops the server, removes the Postgres container and deletes
`.demo/`. If the terminal is gone, `make demo-down` does the same.

### Drive it yourself

```sh
make demo-manual
```

starts the same instance and stops before the worker. It prints the commands; run them in a
second terminal, in this order:

```sh
. .demo/env
agentfund approve http://localhost:8787/hello   # the fingerprint, every prompt in a pager, then yes/no
agentfund dry-run hello                         # what would run next; claims nothing
agentfund work hello --once                     # one task
sh scripts/demo.sh ci                           # play CI: pass, then merge
agentfund status
```

This is the session in the README's recording. Run `work` again without re-approving and you
get exit status 3 and `project moved to …; run agentfund approve …`.

### When it does not work

| You see | Do |
| --- | --- |
| `missing on PATH: …` | Install what it names. |
| `Docker is installed but not running.` | Start Docker. |
| `Something already answers on http://localhost:8787, or .demo/ exists…` | `make demo-down`, or `DEMO_PORT=8788 make demo`. |
| A `FAIL` line followed by server log | The last 40 lines of the server log are printed under it. `.demo/server.log` has the rest. |

`sh scripts/demo.sh --help` lists the environment variables (`DEMO_PORT`, `DEMO_PACE`,
`NO_OPEN`, `DEMO_DIR`).

## Part 2: for real

Read the [Status section](../README.md#status) first. In short: the loop is proven against a
mock agent and with a real model on the sample project, and the GitHub path is proven once by
hand. Pull requests from a fork, which is how most donations work, are not yet exercised.
Treat your first run as a test.

### Back a project

```sh
curl -fsSL https://raw.githubusercontent.com/ghvstcode/agentfund/main/scripts/install.sh | sh
agentfund version                              # the sandbox and proxy images, by digest
docker pull <each image agentfund version names>
gh auth login                                  # the worker forks, pushes and opens the PR as you
export CLAUDE_CODE_OAUTH_TOKEN=...             # from `claude setup-token`; or ANTHROPIC_API_KEY

agentfund login   https://fund.example         # paste an API key from the instance's Settings page
agentfund approve https://fund.example/gridrs
agentfund dry-run gridrs
agentfund work    gridrs --once --budget 2m
agentfund logs                                 # then read the run: agentfund logs <claim>
```

Differences from the demo: the sandbox image contains the real Claude Code CLI, the proxy
lets it reach the model API and nothing else, tokens are billed to you, and the result is a
pull request on GitHub that the project's own CI judges. Whether donating inference fits your
plan is between you and your provider; see [FAQ](faq.md).
Everything else: [Donor guide](donors.md).

### Fund your project

Start from [`examples/hello-project`](../examples/hello-project/), which is the project the
demo just ran:

```sh
agentfund validate tasks/
agentfund keygen
agentfund sign tasks/
```

then push, and register the repository under **Maintain** on an instance. Be your own first
donor before you invite anyone: `agentfund work <slug> --once --task <task-id>`.
Everything else: [Maintainer guide](maintainers.md).

### Run an instance

```sh
docker compose up                # http://localhost:8787; --build builds from a checkout
```

Everything else: [Self-hosting](self-hosting.md).

## Next

[Concepts](concepts.md) follows one task through every stage you just watched.
