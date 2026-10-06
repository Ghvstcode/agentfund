# hello-project

The smallest complete AgentFund project: three tasks, a project descriptor, one signature and
a hardened CI workflow. Copy it to start your own. It is also the project
[`make demo`](../../docs/quickstart.md) runs, and the fixture for the spec validator and the
end-to-end test, so it is known to work.

```
agentfund.yaml               project descriptor + the maintainer's public key
tasks/0001-slugify.yaml      a task manifest
tasks/0002-truncate.yaml     depends on 0001
tasks/0003-cli.yaml          depends on 0001 and 0002
tasks/MANIFEST.lock          the SHA-256 of every manifest       (written by `agentfund sign`)
tasks/MANIFEST.lock.minisig  one signature over the lock         (written by `agentfund sign`)
.github/workflows/ci.yml     the CI that decides whether tokens count as delivered
src/, tests/                 empty packages for the tasks to fill
```

## See it run

From the repository root, `make demo` signs a copy of this directory, registers it on a local
instance and runs a worker through the first two tasks with a mock agent. No tokens are spent.

## Check the signature yourself

```sh
minisign -Vm tasks/MANIFEST.lock -P RWQCyLdlfJtEHx95UL4Nw0ve1vBqeJXp5gWNdpBaBMMddD56o+4tCh9n
```

prints `Signature and comment signature verified`. Change one character in any manifest and
`agentfund validate tasks/` still passes, but the hash in the lock no longer matches, and
every worker and every instance refuses the task set until it is signed again.

## Use it as a template

1. `agentfund keygen` generates a key pair and prints the public key.
2. Edit `agentfund.yaml`: paste the public key, set `repo_url`.
3. Write your manifests under `tasks/`. One task, one or two files, and a `verify` command
   the agent cannot satisfy by weakening a test. The [Maintainer guide](../../docs/maintainers.md)
   is about exactly this.
4. `agentfund validate tasks/` checks the schema and lints.
5. `agentfund sign tasks/` writes `MANIFEST.lock` and `MANIFEST.lock.minisig`.
6. Commit everything, push, and register the repository under **Maintain** on an instance.

Keep [`.github/workflows/ci.yml`](.github/workflows/ci.yml) or harden your own the same way:
it runs on `pull_request`, never `pull_request_target`, with a read-only token and no secrets.

> [!WARNING]
> The key committed here is a throwaway. Its private half is in `.example-key/` **for tests
> only**. Never reuse it; generate your own before you sign anything real.
