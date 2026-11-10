# Maintainer guide

New here? Run the [zero-token demo](quickstart.md) first; [Concepts](concepts.md) explains the
moving parts.

AgentFund lets strangers spend their own AI inference on your project. You write small,
signed task manifests; their workers run each one in a sandbox and open a pull request; your
CI decides whether it counts; you decide whether it merges.

## The short version

```sh
agentfund validate tasks/        # schema-check and lint every manifest
agentfund keygen                 # once: your signing key; prints the public key
$EDITOR agentfund.yaml           # pubkey: RWQ...
agentfund sign tasks/            # writes tasks/MANIFEST.lock and MANIFEST.lock.minisig
git add agentfund.yaml tasks/ && git commit -m "tasks: sign task set" && git push
# on the instance: Maintain → Register a project, then add the CI webhook to the repository
agentfund approve <instance>/<slug>                # be your own first donor:
agentfund work <slug> --once --task <task-id>      # one task, in the real sandbox
```

That part takes an afternoon. The hard part is **decomposition**: turning a project into
tasks that an agent which cannot ask you anything can finish, in parallel with other agents
it will never meet, judged by a test it cannot edit. Most of this guide is about that. The
running example is [gridrs](https://github.com/Ghvstcode/gridrs), a terminal spreadsheet in
Rust split into 23 manifests (the `agentfund` organisation name is a placeholder until launch).

> [!IMPORTANT]
> This is pre-release software. Only GitHub is supported as a git host, and only the Claude
> Code runner exists. The full loop is proven against a mock agent and the GitHub path has
> been proven once by hand; a real model inside the sandbox has not been run yet. The
> [Status section of the README](../README.md#status) is kept current. gridrs's manifests
> were dry-run by agents outside the sandbox (see
> [What dry-running taught us](#what-dry-running-taught-us)).

**Contents:** [1. Fit](#1-is-your-project-a-fit) · [2. Mechanics](#2-the-mechanics-end-to-end) ·
[3. Decomposing](#3-how-to-decompose-a-project-into-manifests) ·
[4. Good/bad pairs](#4-three-goodbad-pairs) · [Dry-running](#what-dry-running-taught-us) ·
[5. Re-signing](#5-re-signing-after-edits) · [6. Keys](#6-key-management) ·
[7. CI hardening](#7-ci-hardening-checklist) ·
[8. Reviewing PRs](#8-reviewing-and-merging-agentfund-pull-requests) ·
[9. Generic CI](#9-ci-that-is-not-github-actions-the-generic-adapter) · [10. FAQ](#10-faq)

## 1. Is your project a fit?

| It fits when | Why |
| --- | --- |
| **The work can be scoped.** You can name the one or two files a task will change before anyone starts. | Scope is enforced mechanically: a run that touches anything else is discarded. |
| **The result is testable offline.** A command can decide pass or fail with no network, no secrets, no human. | That command is `verify`, and your CI is the only thing that turns tokens into *delivered*. |
| **Everything is public.** Repository, prompts, tests. | Donors read every prompt before approving, and the model provider sees whatever the agent reads. |
| **You will review pull requests.** | Passing CI is not a correctness proof. Merging stays a human decision. |

It does not fit when tasks need credentials or a staging environment, when "done" is a matter
of taste (design, copy, API shape), when the work is one large refactor across shared files,
or when you cannot say what you want precisely. Agents contribute labour, not direction:
every behaviour should be chosen and written down by you first.

## 2. The mechanics, end to end

A project repository carries three things ([spec](../spec/manifest.md)).
[`examples/hello-project`](../examples/hello-project) is a minimal template.

| File | Holds |
| --- | --- |
| `agentfund.yaml` | The descriptor and your public key. |
| `tasks/NNNN-slug.yaml` | One manifest per task. |
| `tasks/MANIFEST.lock`, `tasks/MANIFEST.lock.minisig` | The hash of every manifest, and one signature over the list. |

1. Write manifests ([section 3](#3-how-to-decompose-a-project-into-manifests)), then check them:
   `agentfund validate tasks/` (add `--strict` to fail on warnings).
2. Generate your signing key, once. `agentfund keygen` prompts for a password and prints:
   ```
   secret key:  ~/.config/agentfund/keys/default.key
   public key:  RWQ...
   fingerprint: SHA256:...
   ```
3. Put the public key in `agentfund.yaml`:
   ```yaml
   spec_version: 1
   name: gridrs
   description: A terminal spreadsheet in Rust.
   repo_url: https://github.com/you/gridrs     # must equal the URL you register
   ci_provider: github                         # or: generic (section 9)
   pubkey: RWQ...                              # from `agentfund keygen`
   base_branch: main
   token_goal: 58500000                        # optional; validate warns if below the sum of max_tokens
   ```
4. Sign: `agentfund sign tasks/` writes both lock files.
5. Commit the lock files with the manifests, and push:
   `git add agentfund.yaml tasks/ && git commit -m "tasks: sign task set" && git push`

`validate` checks strict YAML (no anchors, aliases, merge keys, tags or multiple documents),
the JSON Schema, that `id` equals the file name, and that `depends_on` exists and has no
cycles. Errors block signing. Warnings do not, but each one is something a donor reading
your manifest is right to refuse:

| Finding | Trigger |
| --- | --- |
| Warning: `scope.write "**" is too broad` | A write glob of `**`, `*`, `**/*` and similar. |
| Warning: `verify "..." is trivially true` | `true`, `:`, `exit 0`, a bare `echo`, or anything ending in `\|\| true` / `; true`. |
| Warning: `prompt is only N characters` | Under 80 characters. |
| Warning: `max_tokens N is above 5000000` | Above the default per-task cap for new projects. |
| Warning: `timeout_minutes is not set (defaults to 60)` | Missing. |
| Warning: `token_goal N is below the sum of max_tokens` | `agentfund.yaml` promises less than the tasks can cost. |
| **Error:** `addresses a never-writable path` | A write glob naming `agentfund.yaml`, `tasks/` or `.github/`. |

The lint catches the lazy cases. It cannot tell whether a prompt is precise or a `verify` is
independent; that is on you.

### Register the project

1. Sign in to the instance, open **Maintain → Register a project**, and paste the repository
   URL. The repository must be public: the instance clones it without credentials. The wizard
   clones it, verifies the lock signature against the key in `agentfund.yaml`, and shows you the
   key fingerprint, the commit, the lock hash and the manifest list before anything is created.
2. Confirm. The key in `agentfund.yaml` at that moment becomes the **registered key**; from
   then on it changes only through a signed [rotation](#rotation). If the instance requires
   approval for new projects, yours starts `pending` until an admin activates it.
3. Publish the fingerprint somewhere else you control (README, website). Donors compare.
4. Add the CI webhook, so the instance hears from GitHub. Every project has its own webhook
   secret, generated at registration; the wizard and the **Maintain** page show it with the
   payload URL, and let you rotate it (the old secret stops working immediately). In the
   repository: Settings → Webhooks, payload URL `<instance>/v1/webhooks/ci`, content type
   `application/json`, that secret, events *Workflow runs*, *Check suites*, *Pull requests*
   and *Pushes*.

An instance run with `CI_POLL=true` polls GitHub instead and needs no webhook. Operator side:
[self-hosting](self-hosting.md).

### What happens on each push

For every project the instance keeps a clone. It re-indexes on creation, on a push webhook to
the base branch, on a timer (default every 60 s), and when you press **Re-pin**:

1. It resolves the target commit: the head of `base_branch` when **Follow** is on.
2. It verifies the lock signature against the registered key (following rotations) and
   checks every manifest hash.
3. On success it moves the **pinned commit**, updates the task list, and logs
   `manifest.added/changed/removed` and `project.repinned` in the public audit log.
4. On failure the pin stays where it was, the dashboard shows *The latest commit was not
   indexed* with the reason, and donors keep working from the last good pin.

| Dashboard control | Effect |
| --- | --- |
| **Follow `main`** (on by default) | The pin advances to each validly signed head. Needed so tasks with dependencies are claimed against a commit that contains the merged work. |
| **Re-pin** | Index now. Empty pins the branch head; a 40-hex commit pins that commit. Pinning a commit older than a merge also reopens that merge's dependents, against the older commit. |
| **Pause / Resume** | A paused project refuses new claims (`project-not-active`). Running claims continue. |
| **Token goal** | The number the progress bar is measured against. |

**Every merge moves the pin, and donors' approvals are per commit.** By default a donor's
worker runs only the commit they approved and its ancestors. After your first merge the pin
is a new commit, and their worker claims nothing at it until they re-approve. The exception
is `follow_unchanged_lock`, which `agentfund approve` asks donors about: it accepts newer
commits whose `MANIFEST.lock` is byte-identical. So:

- Tell your donors this in your README.
- Do not touch `tasks/` unless you mean to. A merge that leaves the lock byte-identical costs
  opted-in donors nothing; any lock change sends every donor back to `approve`.

## 3. How to decompose a project into manifests

A manifest is a ticket for a contractor who cannot ask questions, cannot see the other
contractors, and is paid by someone else. These are the rules gridrs ended up with.

### Lay out the skeleton first

Before the first task existed, gridrs's `main` had every module declared, every shared type
defined (`src/types.rs`), and every public function stubbed with its final signature and a
doc comment. Tasks fill in bodies; they never change shapes. That is what lets ten agents
write code that links.

The files that hold the contract (`Cargo.toml`, `src/lib.rs`, `src/main.rs`, `src/types.rs`,
every `mod.rs`) are in **no** task's write scope. Shared files are designed away up front:
the module list is pre-declared; the function library dispatches through a frozen
`funcs/mod.rs` into four files owned by four tasks.

### One task, one or two files

Tasks in the same layer run at the same time, on different machines, from the same base
commit. If two of them can write the same file, the second pull request conflicts and that
donor's tokens are wasted. So in gridrs:

- every source file is owned by exactly one task;
- `scope.write` is a list of literal paths, with no globs at all;
- a script (`ci/scope-audit.sh collisions`) proves no two tasks share a writable path.

```yaml
scope:
  write:
    - src/io/csv.rs
    - ci/done/0302-csv
```

### Wide, not deep

`depends_on` means **merged**, not "PR open": a dependent task is not claimable until you
have reviewed and merged its dependencies, and the instance has read the branch since then (the
push webhook, the timer or **Re-pin**), so the dependent is claimed against a commit that contains
the merged work. A chain of twenty tasks is twenty review cycles.
gridrs has 23 tasks in 6 layers, 18 of them in the first two:

```
layer 0   addresses  values  lexer  ref-rewriting  csv  dep-graph  history  terminal-input
layer 1   parser  evaluator  math  logic  text  lookup  number-format  native-format  renderer  commands
layer 2   sheet
layer 3   sheet-ops  files
layer 4   app
layer 5   cli
```

Width comes from interfaces that do not need each other's implementations. The evaluator
calls functions through a trait, so its test brings its own. The renderer draws anything
implementing `GridSource`, so it does not need the sheet. The reference rewriter works on
hand-built trees, so it does not need the parser. If task B only needs A's *signature*, B
does not depend on A.

### Put the judge outside every write scope

Each task has an acceptance test that you wrote, that existed and **failed** before the task
was claimable, and that no task may edit. The gridrs mechanism has four parts:

| Part | What it is |
| --- | --- |
| `acceptance/t0302_csv.rs` | The acceptance test for task `0302-csv`. In no task's write scope. |
| `[[test]]` target in `Cargo.toml` | One named test target per task (`autotests = false`), so a single task's test can run alone: `cargo test --test t0302_csv`. |
| `ci/done/0302-csv` | An empty marker file. The task creates it (it is in its `scope.write`); one file per task, so markers never collide. |
| `ci/check.sh [task-id]` | The gate. Builds, runs unit tests, compiles **every** acceptance target (so nobody's signature drifted), then runs the acceptance test of every task that has a marker. With a task id it also requires that task's marker. |

The manifest's `verify` is `sh ci/check.sh 0302-csv`; CI runs `sh ci/check.sh`. The effect:

- An agent cannot pass by editing the test, the gate or the workflow: they are out of scope,
  and a run that touches them is discarded by the worker.
- A marker without a passing test fails CI, so creating the marker is a claim CI checks.
- Merged work stays merged: once a marker is on `main`, that task's test runs on every later
  pull request. The regression suite grows by one file per merge with no list to maintain.
- CI rejects pull requests that remove or modify an existing marker.

Nothing here is Rust-specific. Elsewhere: one test file per task in a directory outside all
scopes (`acceptance/test_0302_csv.py`, `acceptance/0302_csv_test.go` as its own package), a
marker directory, and a short script that loops over markers and runs
`python3 -m unittest acceptance.test_<id>` or `go test ./acceptance/<id>/...` for each.

Markers are not required either. Any `verify` that fails before and passes after, cannot be
satisfied by editing files in scope, and runs offline in the sandbox image will do. The
marker pattern is what lets one shared gate script serve every task and every later pull
request.

### `verify` must fail first, and must not be satisfiable by weakening tests

Two checks before you sign, for every task:

1. **It fails on the untouched repository.** gridrs: `sh ci/check.sh 0302-csv` fails on the
   skeleton. A task that passes before it is done is not a task.
2. **The agent cannot make it pass except by doing the work.** If `verify` runs tests the
   task itself may write, the cheapest way to green is a weaker test.

Agents may add their own unit tests next to their code; those run in the gate too, but they
are not the judge.

### The sandbox is offline, and it is not your repository

What `verify` and the agent actually get:

| In the sandbox | Consequence for you |
| --- | --- |
| **No network** except the model API. By default it reaches `api.anthropic.com` and nothing else: no package registry and, unless the donor opts in, not even the git host. | `cargo fetch`, `npm install`, `pip install`, `go mod download` all fail. Vendor your dependencies or stay standard-library-only, and make the commands offline-safe (`cargo --offline --locked`, `GOFLAGS=-mod=vendor`). |
| **No `.git`, no `tasks/`, no `agentfund.yaml`.** They are removed from the working tree. | `verify` must not call `git`. Scripts that read manifests must tolerate their absence (gridrs's `ci/lock-check.sh` skips when `tasks/` has no manifests). Say everything the agent needs in the prompt: it gets the `prompt` text verbatim on standard input and cannot read the manifest file. |
| **A read-only tree.** Only paths matching `scope.write` are writable. | Build output cannot go into the repository directory (`./target`, `./node_modules/.cache`, `__pycache__`); it must go to `/tmp` or `$HOME`, both tmpfs. The reference image sets `CARGO_TARGET_DIR`, `GOCACHE`, `PYTHONPYCACHEPREFIX` and the npm cache accordingly. |
| **The reference sandbox image**, not your CI image: Debian with Node 22, Python 3, Go, Rust (stable, *minimal* profile: no clippy, no rustfmt), a C toolchain, `git`, `jq`. | If `verify` needs a tool that is not there, it fails for every donor. gridrs's gate runs clippy only if it is installed, and only deny-by-default lints fail it, so a sandbox without clippy cannot produce work that CI with clippy then rejects over style. |
| **`scope.read`** (optional). | Removes everything matching neither it nor `scope.write` from the sandbox. Unset means the whole repository is readable. |
| **Limits.** Unprivileged user, read-only root file system, 2 CPUs / 4 GB / 512 processes by default. | Donors can change the resource numbers. |

### Size `max_tokens` and `timeout_minutes`

`max_tokens` counts input (including cache reads and cache writes) plus output over every
model call; an agent that reads a lot burns it quickly. `timeout_minutes` covers agent plus
`verify`.

> [!WARNING]
> The sandbox is killed at the cap and the run is reported `budget_exceeded`: the donor paid,
> nothing was delivered. Too small is worse than too large.

gridrs uses 1.5M to 4M tokens and 20 to 45 minutes: small enough that a failed run is a
shrug, large enough to be a real unit of work (a parser, a file format, a renderer). These
figures are estimates; no gridrs task has yet been run by a real worker.

Until **3 tasks have merged**, a project is `new`, and three limits apply. Plan layer 0
around them. They are instance and donor settings; the numbers are the defaults.

| Limit | Default | Consequence |
| --- | --- | --- |
| Server: per task | 5,000,000 | Claims on larger manifests are refused (`project-task-cap`). `validate` warns. |
| Server: per UTC day | 25,000,000 (sum of `max_tokens` of claims granted) | gridrs's layer 0 is 18.5M and layer 1 is 23M, so the first two layers take two days on a fresh instance. |
| Donor: `new_project_max_tokens_per_task` | 5,000,000 in the default donor config (the same as the server's per-task cap) | A donor may lower it; the worker uses the minimum of this, the donor's `max_tokens_per_task` and the server's cap. Smaller early tasks are claimable by more donors. |

### Never-writable paths

Regardless of `scope.write`, no task can change `agentfund.yaml`, `tasks/**`, `.github/**` or
anything under `.git`. `.github/**` is the judge and the other two are the rules: a task that
could edit either could approve itself, or change what the next donor's agent is told after
that donor reviewed it. The worker discards a run that tries, and `validate` rejects a
manifest that asks. If CI needs to change, change it yourself, on `main`. Also discarded:
symlinks, hard links, files over 5 MB and change sets over 50 MB.

## 4. Three good/bad pairs

### A vague prompt vs a precise one

Bad. Two reasonable implementers would produce two different modules, and neither would
link with the rest:

```yaml
prompt: |
  Implement cell address parsing for the spreadsheet (A1 notation, ranges,
  absolute references). Add tests.
```

Good. The length is edge cases, not adjectives: every sentence is there because without it
two implementers would have disagreed. It also says what exists, what must not be touched,
how the result is judged, and which side wins when prompt and test disagree.

<details>
<summary>gridrs <code>tasks/0001-cell-addresses.yaml</code>, trimmed (the original is 94 lines)</summary>

```yaml
spec_version: 1
id: 0001-cell-addresses
title: "A1 addressing: column letters, cells, $-references, ranges"
prompt: |
  gridrs is a terminal spreadsheet written in Rust with the standard library
  only. [...] The skeleton of the whole program already exists: every module
  is declared, every public function has its final signature and a doc
  comment, and the bodies are stubs. Your job is to replace the stubs named
  below with a real implementation. You cannot ask questions: everything you
  need is in this text, in the repository, and in the acceptance test.

  Implement A1-style cell addressing in `src/addr.rs`. [...]

    letters_to_col(s: &str) -> Option<u32>
      Inverse, ASCII case-insensitive ("aa" -> 26). None when `s` is empty,
      contains anything but ASCII letters, or names a column >= MAX_COLS
      ("XFE", "ZZZZ"). Must not overflow on absurdly long input.

    parse_cell(s: &str) -> Option<CellRef>
      One or more ASCII letters followed by one or more ASCII digits, nothing
      else: "B12" -> CellRef::new(1, 11). [...] The row number is 1..=MAX_ROWS
      with no leading zero ("A0", "A01", "A1048577" are None). [...]

  Rules
    - You may change ONLY the file `src/addr.rs`, plus the marker file
      ci/done/0001-cell-addresses. A change to any other file [...] makes the
      whole run be discarded.
    - Standard library only: no new dependencies. There is no network access;
      always pass `--offline` to cargo.
    - Do not change the name, parameters or return type of any existing `pub`
      item in your file(s) [...]

  Finishing
    1. Create the empty marker file for this task:   : > ci/done/0001-cell-addresses
    2. Run the check that will judge your work:      sh ci/check.sh 0001-cell-addresses
    If the acceptance test and this text ever seem to disagree, the acceptance
    test wins: make it pass without touching it.
scope:
  write:
    - src/addr.rs
    - ci/done/0001-cell-addresses
verify: sh ci/check.sh 0001-cell-addresses
max_tokens: 1500000
timeout_minutes: 20
depends_on: []
```

</details>

### An over-broad scope vs a narrow one

Bad. `validate` warns on the first glob, and the manifest collides with every other task
that touches `src/`:

```yaml
scope:
  write: ["**"]            # or the subtler: ["src/**", "tests/**", "Cargo.toml"]
```

Good: the two literal paths shown under
[One task, one or two files](#one-task-one-or-two-files). If a task seems to need a wide
scope, the skeleton is missing something. Add the stub, the shared type or the `mod` line
yourself, on `main`, and narrow the task.

### A self-satisfiable verify vs an independent one

Bad. The task writes the tests that judge it; an empty test file passes:

```yaml
prompt: |
  Implement slugify() in src/textutil.py and add unit tests in
  tests/test_slugify.py.
scope:
  write: [src/textutil.py, tests/test_slugify.py]
verify: python3 -m unittest discover -s tests -p "test_slugify.py"
```

This is the shape of the manifests in `examples/hello-project`, which is a format template,
not a decomposition example. `agentfund validate` reports no warning for it.

Good. The test already exists, fails on the untouched repository, and is outside the scope:

```yaml
scope:
  write: [src/textutil.py]
verify: python3 -m unittest acceptance.test_slugify
```

## What dry-running taught us

Before signing, every gridrs task was implemented once by a separate agent that was given
**only the manifest prompt** and the repository. The log (`dev/dry-run-fix-log.md` in gridrs)
records three kinds of defect, none of which `validate` can see:

| Defect | What happened | Fix |
| --- | --- | --- |
| **Prompts silent on edge cases** | Four prompts (`0002`, `0104`, `0203`, `0204`) said nothing about cases such as rounding non-finite input, the order in which call arguments are evaluated, or which bound `INDEX` checks first. The implementers guessed, and all the guesses happened to pass. The app task left Enter/Tab at the last row and the End key unspecified. | One sentence each in the prompt and, where it mattered, an assertion in the test. A guess that passes today is a disagreement between two donors' agents tomorrow. |
| **A prompt that was wrong** | `0402-sheet` told the implementer to register a formula's precedents with the dependency graph and evaluate whatever the recalculation plan returned. A formula with no references (`=1+2`, `=1/0`) has no precedents, so the graph never planned it and its value stayed empty. Two acceptance tests caught it, at the cost of one failed iteration; with a real donor that is a failed run someone paid for. | The prompt now says reference-free formulas are evaluated on entry, and there is a dedicated test. |
| **Tests looser than the prompt** | In seven tasks the prompt stated a rule that the acceptance test never exercised (a lone CR after a closing quote in CSV, a paste clipped at the last row, `:B12 x` not being a goto). Every existing implementation passed once the assertions were added, but a lazier one would have been "delivered" while wrong. | Where prompt and test differ, the test is the real specification, so make it say everything the prompt does. |

A process note from the same log: two first attempts were stopped because the agent wrote
files and ran the check in one compound shell command. Not a manifest problem, but a reason
to keep the "Finishing" steps as separate, plain commands.

**The advice: dry-run every manifest with an agent that sees only the prompt, before you
sign.**

1. Give it a fresh checkout, the prompt text and nothing else: no issue tracker, no chat with
   you, no reference implementation.
2. Run `verify` on the result and diff the changed paths against `scope.write`.
3. Read what it asks, what it guesses and where it fails. Fix the manifest, not the agent.

This does not test everything. The gridrs dry-runs were not inside the AgentFund sandbox, so
offline behaviour, the read-only tree and the image's toolchain still need a real worker run.
Do one per manifest shape, under your own credentials, before asking anyone else:
`agentfund approve`, then `agentfund work <project> --once --task <id>`
([donor guide](donors.md)).

## 5. Re-signing after edits

**Any** change under `tasks/` (a typo in a prompt, a new manifest, a removed one) changes a
hash in the lock, so:

```sh
agentfund validate tasks/ && agentfund sign tasks/
git add tasks/ && git commit -m "tasks: ..." && git push
```

- Until you do, the instance refuses to index the new head and stays on the old pin.
- A cheap CI check that the lock matches the manifests (gridrs: `ci/lock-check.sh`, hashes
  only) catches "edited and forgot to sign". Do not verify the *signature* in CI as a trust
  decision: CI runs code from the pull request.
- For donors, a changed lock means `approve` again, reading the new task set, unless they
  opted into `auto_follow_signed_updates`. `follow_unchanged_lock` does not help them here;
  the lock changed. Batch manifest edits, and say what changed.

## 6. Key management

- **Password-protect the key.** `keygen` encrypts the secret key (scrypt; the file is
  compatible with stock `minisign`) unless you pass `--no-password`. The password comes from
  a prompt or `$AGENTFUND_KEY_PASSWORD`.
- **Never put it in CI** or in the repository. Signing is something you do at your desk.
- Anyone can check your signature with the stock tool:
  `minisign -Vm tasks/MANIFEST.lock -P "$(yq .pubkey agentfund.yaml)"`.

> [!WARNING]
> Back the key up offline. `~/.config/agentfund/keys/default.key` is the only copy. If you
> lose it you cannot sign, and you cannot rotate either, because rotation is signed by the old
> key. The only way out is a new project registration and every donor approving a new key.

| Flag or variable | Effect |
| --- | --- |
| `keygen --name NAME` | Key name and file stem (default `default`), for more than one key. |
| `keygen --out DIR` | Directory for the key files (default `~/.config/agentfund/keys`). |
| `keygen --no-password` | Write the secret key unencrypted. |
| `keygen --force` | Overwrite an existing key of the same name. |
| `sign --key PATH`, `$AGENTFUND_KEY` | Secret key to sign with. Default: the only key in the keys directory. |
| `sign --rotate-from OLDKEY` | Append a rotation link from the old key to `--key`. |

### Rotation

```sh
agentfund keygen --name 2027
agentfund sign tasks/ --key ~/.config/agentfund/keys/2027.key \
                      --rotate-from ~/.config/agentfund/keys/default.key
# rotation: SHA256:<old> -> SHA256:<new>
$EDITOR agentfund.yaml        # pubkey: <new public key>  (sign prints a warning until you do)
git add agentfund.yaml tasks/ && git commit -m "tasks: rotate signing key" && git push
```

`--rotate-from` appends a statement "from old key to new key", signed by the **old** key, to
the lock's `rotations` list, then signs the lock with the new key. Existing links are kept; a
chain may be at most 16 long.

- **The server** follows the chain from the registered key, shows the new key and
  fingerprint on the Audit tab, and logs `project.key_rotated`.
- **Donors' workers** keep trusting only the key they pinned, plus keys reachable from it
  through validly signed links. A rotated lock therefore verifies without re-pinning, but the
  lock bytes changed, so donors without `auto_follow_signed_updates` re-approve; `approve`
  tells them a valid rotation chain leads to the new key.
- If the old key was **stolen**, rotation does not help: the thief can sign a rotation too.
  Pause the project and tell donors out of band.

## 7. CI hardening checklist

Every AgentFund pull request is code written by a model, prompted by you, run by a stranger,
and reviewed by nobody before your CI executes it. Treat each one as an untrusted fork PR.
The worker's scope check limits *where* the change is, not what it does.

- [ ] **Trigger on `pull_request`, never `pull_request_target`.** For `pull_request` from a
  fork, "the `GITHUB_TOKEN` has read-only permissions" and, apart from that token, "secrets
  are not passed to the runner". `pull_request_target` runs in the base repository's context
  with its secrets; GitHub warns that untrusted code there "may lead to security
  vulnerabilities". Same for `workflow_run` workflows that check out PR code. ([events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull-request-events-for-forked-repositories),
  [secure use](https://docs.github.com/en/actions/reference/security/secure-use))
- [ ] **`permissions: contents: read`** at the top of the workflow, and nothing else. Set the
  repository default to read-only too (Settings → Actions → General → Workflow permissions).
- [ ] **No secrets in any job that runs PR code.** No deploy keys, no registry tokens, no
  self-hosted runners (GitHub: they "can be persistently compromised by untrusted code").
- [ ] **Pin actions by full commit SHA**, e.g.
  `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`. GitHub calls this
  "the only way to use an action as an immutable release". Set `persist-credentials: false`
  on checkout.
- [ ] **`timeout-minutes` on every job** and a concurrency group that cancels superseded runs:
  ```yaml
  concurrency:
    group: ci-${{ github.ref }}
    cancel-in-progress: true
  ```
- [ ] **Require approval for fork workflow runs.** Settings → Actions → General → *Approval
  for running fork pull request workflows from contributors*. The default covers first-time
  contributors; *Require approval for all external contributors* is the strict choice. A
  donor's tokens stay *reported* until you click approve and CI finishes, so check the queue.
  ([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks))
- [ ] **Branch protection on the base branch:** require a pull request with at least one
  human review, and require your CI check to pass, before merging.
  ([docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches))
- [ ] **No auto-merge.** Passing CI means the tokens are delivered. It does not mean the
  change is right.
- [ ] **Download nothing in CI that the PR can influence.** gridrs has no dependencies and
  runs `cargo --locked --offline`.
- [ ] **Keep the judge out of scope.** Tasks can never write `.github/**`, but your gate
  script and acceptance tests are ordinary files: make sure no manifest's `scope.write`
  covers them. gridrs's CI also fails any PR that removes or edits a `ci/done/` marker.

[`gridrs/.github/workflows/ci.yml`](https://github.com/Ghvstcode/gridrs/blob/main/.github/workflows/ci.yml)
and [`examples/hello-project/.github/workflows/ci.yml`](../examples/hello-project/.github/workflows/ci.yml)
implement the workflow-file items.

## 8. Reviewing and merging AgentFund pull requests

A worker's pull request comes from the donor's fork, on branch
`agentfund/<task-id>-<first 8 characters of the claim id>`, titled `<task title> (<task-id>)`,
with a single commit authored by `AgentFund worker <worker@agentfund.invalid>`:

```
CSV reader and writer (RFC 4180)

Automated change produced by an AgentFund worker run.

AgentFund-Task: gridrs:0302-csv
AgentFund-Claim: clm_...
AgentFund-Manifest-SHA256: <sha256 of tasks/0302-csv.yaml as signed>
```

The PR body repeats the task, claim, **manifest SHA-256**, base commit, tokens in/out, the
runner version, the verify command, the list of changed paths, and a pointer to the run's
report on the instance, where the worker's log digest is published. Before reading the diff:

1. Check the manifest hash. It must equal the Manifest SHA-256 in the PR body:
   `shasum -a 256 tasks/0302-csv.yaml`
2. Check that the changed paths are inside that manifest's `scope.write`.

An honest worker enforces both, but the pull request is just a pull request: anyone can open
one that looks like this. Your CI and your review are the checks that matter.

| State | Meaning | Evidence |
| --- | --- | --- |
| reported | A worker says it spent the tokens (includes failed runs). | The worker. |
| **delivered** | Every completed CI run for the PR's head commit succeeded. | GitHub (webhook or poll). |
| **merged** | You merged the PR. The task is done and its dependents become claimable. | GitHub. |

| When | What happens |
| --- | --- |
| CI fails | The report is marked `ci_failed`, the task reopens, and a new attempt is a new claim and a new pull request. Close the old one. |
| You close without merging | The task reopens for another donor. If CI had already passed, those tokens stay delivered (CI did pass) and are never counted as merged. |
| You push a fix-up commit to the PR and merge | It still counts as merged; merges are matched on branch and PR URL, not head SHA. |
| A task keeps producing bad PRs | A manifest problem. Pause, fix the prompt or the test, re-sign. |

## 9. CI that is not GitHub Actions: the generic adapter

Set `ci_provider: generic` in `agentfund.yaml` and have your CI post one signed JSON document
per finished run to the instance. The body is a `GenericCiResult`; the header carries the
HMAC-SHA256 of the raw body under the project's webhook secret:

```sh
body='{"provider":"generic","repo_url":"https://github.com/you/proj","branch":"agentfund/0001-x-ab12cd34","head_sha":"<40 hex>","conclusion":"success","run_url":"https://ci.example/runs/42"}'
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$PROJECT_WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST "$BASE_URL/v1/webhooks/ci" \
  -H "X-AgentFund-Signature: sha256=$sig" \
  -H 'content-type: application/json' \
  -d "$body"
# → 202 {"matched":true}   (false: no report has that branch + head_sha yet; the result is kept)
```

| Field | Required | Value |
| --- | --- | --- |
| `provider` | yes | `"generic"` |
| `repo_url` | yes | The project repository (as registered). It selects the project whose secret is checked. |
| `branch`, `head_sha` | yes | The PR's branch and its 40-hex head commit. They must equal what the worker reported. |
| `conclusion` | yes | `success`, `failure` or `cancelled`. |
| `run_url` | no | Shown in the ledger as the evidence link. |
| `merged` / `closed` | no | `true` when the PR merged / was closed unmerged. Send `merged` only once the merge is on the base branch: dependents open on the next index after it. |

Before choosing it:

- The repository must still be on **github.com**: the worker can only publish there. The
  generic adapter replaces GitHub Actions as the judge, not GitHub as the host.
- A `generic` project ignores GitHub webhooks and is not polled. Your CI must also report
  merges (`"merged": true`) or tasks never reach *merged* and dependents never open; and
  re-indexing after a push relies on the timer or the **Re-pin** button.
- The signing job holds the project's webhook secret, so it must not run PR-controlled code.
  Run the tests in one job and sign in a separate, trusted one.
- Sign the exact bytes you send. `printf '%s'` and `-d "$body"` keep them identical.

## 10. FAQ

General questions are in the [FAQ](faq.md). These three are maintainer-only.

**A task keeps failing. What do I do?** Look at how:

| Outcome | Likely cause | Do |
| --- | --- | --- |
| `budget_exceeded` or `timeout` | The task is too big, or the prompt sends the agent exploring. | Split it or raise the cap. |
| `failed` (verify) | The prompt and the test disagree, or `verify` needs something the sandbox does not have (network, a tool, a writable build directory). | The ledger shows the failed report but not why (the reason is in the donor's local log), so reproduce it with an agent that sees only the prompt. |
| `verification_failed` with a scope violation | The prompt implies changes outside `scope.write`. | Add the missing stub yourself. |

Each donor's worker waits 24 hours by default before retrying a task that failed on that
machine, so a broken task quietly starves. Fix and re-sign rather than wait.

**Can I change a task mid-flight?** Yes: edit, `sign`, push. If the task is open it is
updated in place. If it is claimed, that claim continues against the commit it was granted
for, and the pull request may reflect the old prompt. Delivered and merged tasks are never
reopened by an edit. Donors must re-approve the new lock.

**How do I remove a task?** Delete the manifest (and anything in other manifests'
`depends_on` that names it, or signing fails), `sign`, push. An open or claimed task becomes
`failed`; a delivered or merged one is untouched in the ledger. A manifest that reappears
later reopens. You do not need to delete manifests of merged tasks; leaving them keeps the
lock stable.
