<!-- Title: a conventional commit, e.g. `fix(worker): release the claim when verify times out`. -->

## What and why

## How it was tested
<!-- Commands you ran. `make e2e` for anything on the claim → sandbox → report → CI → ledger path. -->

## Checklist

- [ ] Spec first: if behaviour changed, `spec/` changed in this PR and `pnpm spec:check` passes
- [ ] Generated API types are current (`pnpm --filter web gen:api`, `pnpm --filter server generate`)
- [ ] Docs match: flags, defaults and messages I changed are updated, and `make check` passes
- [ ] Tests added or updated
- [ ] `CHANGELOG.md` has a line under *Unreleased* (user-visible changes only)
- [ ] Nothing here makes a worker trust the server for something it used to verify itself
