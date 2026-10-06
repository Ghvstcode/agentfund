# hello-project

A copyable AgentFund example project: three small manifests, a project descriptor and
hardened CI. It is also the fixture the spec validator and the end-to-end test run against.

```
agentfund.yaml              project descriptor + maintainer public key
tasks/0001-slugify.yaml     a task manifest
tasks/0002-truncate.yaml    depends on 0001
tasks/0003-cli.yaml         depends on 0001 and 0002
tasks/MANIFEST.lock         hash of every manifest        (written by `agentfund sign`)
tasks/MANIFEST.lock.minisig one signature over the lock   (written by `agentfund sign`)
.github/workflows/ci.yml    CI that decides whether tokens count as delivered
```

To use it as a template:

1. `agentfund keygen` — generates a keypair and prints the public key.
2. Edit `agentfund.yaml`: paste the public key, set `repo_url`.
3. `agentfund validate tasks/` — schema check + lint.
4. `agentfund sign tasks/` — writes `MANIFEST.lock` and `MANIFEST.lock.minisig`.
5. Commit everything and publish the branch.

The key committed here is a throwaway whose private half lives in `.example-key/`
**for tests only** — never reuse it.
