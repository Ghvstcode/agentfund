# AgentFund spec

The contract every AgentFund component implements. The code follows these files, not the
other way round: a behaviour change starts here.

| File | Defines |
| --- | --- |
| [`manifest.md`](manifest.md) | Task manifests, `agentfund.yaml`, `tasks/MANIFEST.lock`, the minisign signature and key rotation, and the worker's five-step verification chain |
| [`protocol.md`](protocol.md) | Wire protocol v1: identifiers, authentication, the task state machine, leases and reports, the ledger, CI confirmation, trust caps, indexing, the live stream |
| [`openapi.yaml`](openapi.yaml) | The same API, as OpenAPI 3.1. Server and web types are generated from it |
| [`schemas/manifest.schema.json`](schemas/manifest.schema.json) | One task manifest |
| [`schemas/agentfund.schema.json`](schemas/agentfund.schema.json) | The project descriptor |
| [`schemas/lock.schema.json`](schemas/lock.schema.json) | The lock file |

New to the ideas? [Concepts](../docs/concepts.md) is the gentle version of both prose documents.

## Check it

```sh
pnpm install
pnpm spec:check     # schemas validate examples/hello-project, then Redocly lints the OpenAPI
```

`spec:validate` runs [`scripts/validate-spec.mjs`](../scripts/validate-spec.mjs) against
[`examples/hello-project`](../examples/hello-project/), which is also the fixture for the
end-to-end test. A schema change that breaks the example fails here first.

## Changing it

1. Edit the schema, the OpenAPI file or the prose. Keep the three consistent.
2. `pnpm spec:check`.
3. Regenerate what is derived: `pnpm --filter web gen:api`, `pnpm --filter server generate`,
   and `make -C worker sync-spec` (the worker embeds the schemas; a test fails when the
   copies drift).
4. Update the implementations in the same pull request.

Versioning: manifests and the lock carry `spec_version` and `lock_version`; the API is
negotiated through `protocol_versions` and `spec_versions` in `/v1/meta`.

## Building something compatible

Nothing here is private to the reference implementation. A third-party worker needs
`manifest.md` and the worker half of `protocol.md`; a third-party UI needs only
`openapi.yaml`, because the reference UI uses no endpoint outside it.
