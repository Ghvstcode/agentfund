# Sandbox image

The container a task runs in: the coding agent first, then the manifest's `verify` command.
The worker starts it with no host mounts, as a non-root user, on an internal Docker network
whose only exit is the [egress proxy](../egress-proxy/README.md).

| File | Builds | For |
| --- | --- | --- |
| [`Dockerfile`](Dockerfile) | `agentfund/sandbox:dev` | Real runs. Contains the Claude Code and Codex CLIs and toolchains for Python, Node, Rust, Go and C, so common `verify` commands work without downloading anything |
| [`Dockerfile.e2e`](Dockerfile.e2e) | `agentfund/sandbox-e2e:<scenario>` | Tests and `make demo`. Its `claude` is [`worker/cmd/mock-agent`](../../worker/cmd/mock-agent/), a script that never calls a model |

## Build

```sh
make -C worker sandbox-image     # the real image
make -C worker images            # the real image and the egress proxy
make -C worker e2e-images        # one mock image per scripted scenario (happy, scope, verifyfail, …)
```

No image is published to a registry yet; you build them. The worker looks for
`agentfund/sandbox:dev` unless told otherwise with `--sandbox-image`,
`AGENTFUND_SANDBOX_IMAGE`, or `sandbox.image` in the policy file. For anything beyond
trying it out, pin the image by digest there.

## What is in the real image

Every version is an explicit build argument at the top of the [`Dockerfile`](Dockerfile):
the base image, the Claude Code and Codex CLI versions, the Go version and the Rust toolchain. For a
reproducible build, pin `BASE_IMAGE` by digest.

The agent runs as user `agent` (uid 10001) in `/work`. Toolchains are installed system-wide
and read-only for that user.

## What the image does not do

Isolation is not the image's job. The worker applies it at `docker run` time, and the proxy
enforces the network policy. An image cannot loosen either. What that isolation does and does
not cover is in [Security](../../docs/SECURITY.md); remember that the sandbox is **offline**
apart from the model API, so a `verify` command that needs to download a dependency will fail.
The [Maintainer guide](../../docs/maintainers.md) says how to write tasks for that.

## The mock scenarios

The mock agent's behaviour is chosen by the image (`MOCK_AGENT_SCENARIO`), never by a switch
in the worker, so the worker under test is the worker that ships.

| Scenario | The mock agent | Used to prove |
| --- | --- | --- |
| `happy` | writes a correct implementation and test | the full loop; this is the demo's image |
| `scope` | also writes a file outside `scope.write` | the run is discarded |
| `verifyfail` | writes an implementation whose test fails | nothing is published |
| `budget` | burns tokens without end | the run is killed at the cap |
| `hang` | does nothing forever | the timeout |
| `ratelimit`, `autherror` | exits with a provider error | the claim is released; a rate limit also backs the worker off |
| `unreachable` | never reaches the model API (connection retries, then an error result without an HTTP status) | the claim is released, not failed, and the worker backs off |
| `leak` | writes the credential it was given into an in-scope file | a diff containing the credential is discarded and nothing is pushed |
| `nochange` | succeeds without touching a file | an empty diff is not a result |
