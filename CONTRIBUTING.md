# Contributing

Thanks for looking. This page is the short path from a clone to a merged change.

## Set up

You need Docker (running), Node 22 with pnpm, Go 1.27+, and a Rust toolchain if you touch
the egress proxy.

```sh
make            # lists every target
make demo       # the whole product on your machine, zero tokens; start here
make test       # every package's unit tests
make e2e        # the full acceptance loop against a mock agent
make check      # spec validation + docs link and CLI-reference check
```

`make dev` serves the web UI on :5173 against a built-in mock API, which is the fastest loop
for UI work. `make up` runs a real instance from source on :8787.

## Where things live

| Path | What | Its own tests |
| --- | --- | --- |
| [`spec/`](spec/) | The contract. Schemas, OpenAPI, two prose documents | `pnpm spec:check` |
| [`worker/`](worker/) | The `agentfund` CLI (Go) | `cd worker && go test ./...`; with Docker: `make -C worker test-integration` |
| [`server/`](server/) | API, indexer, claim queue, ledger (TypeScript, Hono, Postgres) | `pnpm --filter server test` |
| [`web/`](web/) | The UI (React). Uses only the public API | `pnpm --filter web test` |
| [`images/`](images/) | Sandbox image; egress proxy (Rust) | `cd images/egress-proxy && cargo test --locked` |
| [`scripts/`](scripts/) | `demo.sh`, `e2e.sh`, the installer, docs tooling | `make e2e`, `make check` |

## Rules of the road

1. **The spec leads the code.** A behaviour change starts in `spec/` (schema, OpenAPI or
   prose), then the worker, server and web follow in the same pull request. `pnpm spec:check`
   must pass, and the generated API types must be regenerated (`pnpm --filter web gen:api`,
   `pnpm --filter server generate`).
2. **The server stays untrusted.** If a change makes a worker rely on something only the
   server says, it needs a very good reason in the pull request description.
3. **Every claim in the docs is true of the code.** If you change a flag, a default or a
   message, change the docs in the same pull request. `make check` catches renamed
   subcommands and flags, and broken links; it cannot catch a wrong sentence.
4. **Tests come with the change.** `make e2e` is the acceptance test for anything that
   touches the claim → sandbox → report → CI → ledger path.
5. **Conventional commits** (`feat:`, `fix:`, `docs:`, …), and a line in
   [`CHANGELOG.md`](CHANGELOG.md) under *Unreleased* for anything a user would notice.

## Docs and README assets

The README's images are generated, not drawn:

```sh
make assets      # hero, social preview, screenshots (mock data), diagrams
make recording   # the terminal GIF and the live page GIFs, from one real demo session (needs vhs)
```

Sources: [`docs/assets/tapes/demo.tape`](docs/assets/tapes/demo.tape) and the
`scripts/readme-*` files. If you change what the CLI prints, re-record.

## Reporting bugs and security problems

Bugs and ideas: open an issue; the templates ask for what we will need. Vulnerabilities:
**not** in a public issue. [docs/SECURITY.md](docs/SECURITY.md) says how to report privately.

## Conduct and licence

Be decent; the [Code of Conduct](CODE_OF_CONDUCT.md) is short. Contributions are accepted
under the project's licence, [Apache-2.0](LICENSE).
