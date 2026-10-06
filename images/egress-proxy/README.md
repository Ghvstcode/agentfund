# egress-proxy

A small CONNECT-only allowlist proxy. It is the **only way out** of the
AgentFund sandbox.

```
 sandbox container            egress-proxy (sidecar)            internet
 (untrusted agent)  ───────►  0.0.0.0:3128            ───────►  allowlisted hosts only
        │                      │            │
        └── --internal net ────┘            └── default bridge
            (no route out)
```

The worker runs each untrusted coding-agent task in a container attached only
to an `--internal` Docker network. This proxy is attached to that network and
to the default bridge. The sandbox is given `HTTPS_PROXY=http://<proxy>:3128`;
anything that is not an HTTPS tunnel to an allowlisted `host:port` is refused.

Part of [AgentFund](../../README.md). The container it guards is the
[sandbox image](../sandbox/README.md); what the pair does and does not protect against is in
[Security](../../docs/SECURITY.md).

Rust, one runtime dependency (`tokio`), `#![forbid(unsafe_code)]`, static musl
binary in a `scratch` image (about 0.4 MB), runs as uid 65532.

## Contract

| | |
|---|---|
| Binary | `/egress-proxy` |
| Listens on | `0.0.0.0:3128` (override with `LISTEN_ADDR`) |
| Protocol | HTTP/1.x `CONNECT host:port` only |
| Health | `GET /healthz` (origin-form) → `200`, body `ok`; `egress-proxy --healthcheck` exits 0/1 |
| Shutdown | SIGTERM / SIGINT: stop accepting, let tunnels run for `SHUTDOWN_GRACE_SECS`, then close them; exit 0 |
| Logs | one JSON object per line on stdout |

### Responses

| Situation | Status |
|---|---|
| CONNECT to an allowlisted `host:port` that resolves to a public address | `200 Connection Established`, then a raw byte tunnel |
| CONNECT to a host/port not on the allowlist | `403`, plain body naming the host |
| CONNECT to an IP literal, in any spelling | `403` |
| CONNECT to an allowlisted name that resolves only to non-public addresses | `403` |
| Any other method or request form (`GET http://…`, `POST`, `GET /`, …) | `405`, `Allow: CONNECT` |
| Malformed request head | `400` |
| Head larger than 8192 bytes | `431` |
| Head not complete within `HEADER_TIMEOUT_SECS` | `408` |
| At `MAX_CONNS` | `503`, closed immediately |
| DNS failure / upstream connect failure | `502` |
| DNS or connect exceeded `CONNECT_TIMEOUT_SECS` | `504` |

Every non-`200` response carries `Connection: close` and the connection is
closed. There is no keep-alive and never a second request on a connection.

### Allowlist (`ALLOW_HOSTS`)

Comma-separated `host[:port]` entries. The port defaults to `443`.

- Match is on the exact `(hostname, port)` pair. `github.com` allows
  `github.com:443` and nothing else — not `github.com:22`, not
  `api.github.com`.
- Hostnames are compared case-insensitively and one trailing dot is ignored
  (`GitHub.com.` = `github.com`).
- An entry may start with `*.` to match **subdomains only**:
  `*.example.com` matches `a.example.com` and `a.b.example.com`, not
  `example.com`. List the apex separately if you want it. The wildcard base
  must have at least two labels (`*.com` is rejected).
- Empty or unset `ALLOW_HOSTS` denies everything.
- The proxy **refuses to start** (exit 2, an `error` log line) on any malformed
  entry: empty entries (`a,,b`, trailing comma), URLs, paths, IP literals, bad
  ports, wildcards anywhere but a leading `*.`, non-LDH characters
  (use punycode for IDNs).

Example: `ALLOW_HOSTS=api.anthropic.com,github.com`

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ALLOW_HOSTS` | *(empty: deny all)* | Allowlist, see above |
| `LISTEN_ADDR` | `0.0.0.0:3128` | `ip:port`, `[v6]:port` or `:port` |
| `MAX_CONNS` | `256` | Max concurrent client connections (1–65536). Each tunnel uses two sockets |
| `ALLOW_PRIVATE_UPSTREAMS` | `false` | `true` disables the resolved-address guard. **Tests only.** Never set in production |
| `HEADER_TIMEOUT_SECS` | `10` | Total time a client has to send its request head |
| `CONNECT_TIMEOUT_SECS` | `10` | Total time for DNS + TCP connect to the upstream |
| `IDLE_TIMEOUT_SECS` | `300` | A tunnel with no bytes in either direction for this long is closed |
| `SHUTDOWN_GRACE_SECS` | `5` | After SIGTERM, how long open tunnels may continue |

The first four are the contract; the timeouts are tuning knobs with safe
defaults. Unset or empty means default; a malformed value is a startup error.

## Log format

One JSON object per line on stdout. Per-connection lines:

```json
{"ts":"2026-10-06T17:41:06.419Z","action":"allow","host":"github.com","port":443,"client":"172.22.0.3:57730","upstream":"140.82.121.3:443"}
{"ts":"2026-10-06T17:41:08.018Z","action":"close","host":"github.com","port":443,"client":"172.22.0.3:57730","reason":"eof","bytes_up":1898,"bytes_down":587603,"duration_ms":1762}
{"ts":"2026-10-06T17:41:08.754Z","action":"deny","host":"example.com","port":443,"client":"172.22.0.3:57754","reason":"not_allowlisted"}
```

| Field | Present on | Notes |
|---|---|---|
| `ts` | all | RFC 3339 UTC, millisecond precision |
| `action` | all | `allow`, `deny`, `error`, `close`; lifecycle: `start`, `shutdown`, `stopped` |
| `host`, `port` | `allow`/`deny`/`error`/`close` | Normalised CONNECT target. `""` / `0` when the request never yielded one (bad request, non-CONNECT, timeout, connection limit) |
| `client` | `allow`/`deny`/`error`/`close` | Peer `ip:port` |
| `reason` | `deny`/`error`/`close` | See below |
| `upstream` | `allow` | The `ip:port` actually dialled |
| `bytes_up`, `bytes_down`, `duration_ms` | `close` | Client→upstream, upstream→client, time since the CONNECT was received |
| `method`, `target` | `deny` with `method_not_allowed` | What was asked for |
| `resolved`, `range` | `deny` with `blocked_address` | First blocked address and why |
| `detail` | some `deny`/`error` | Human-readable cause |

`reason` values — `deny`: `not_allowlisted`, `ip_literal`, `blocked_address`,
`method_not_allowed`, `bad_request`, `head_too_large`, `header_timeout`,
`max_conns`. `error`: `dns_failure`, `dns_timeout`, `dns_no_addresses`,
`connect_failed`, `connect_timeout`, `client_gone`, `incomplete_head`,
`accept_failed`, `invalid_config`, `bind_failed`. `close`: `eof`, `io_error`,
`idle_timeout`, `shutdown`.

An `allow` line is written when the tunnel opens and exactly one `close` line
when it ends. Successful health checks are not logged. Startup line:

```json
{"ts":"…","action":"start","listen":"0.0.0.0:3128","allow":["api.anthropic.com:443","github.com:443"],"allow_private_upstreams":false,"max_conns":256,"header_timeout_ms":10000,"connect_timeout_ms":10000,"idle_timeout_ms":300000,"version":"0.1.0"}
```

All client-influenced strings are JSON-escaped (control characters included)
and truncated to 256 characters, so a client cannot forge or split log lines.

## Threat model

**Adversary:** code running inside the sandbox, steered by prompt injection. It
can open any number of TCP connections to the proxy and send arbitrary bytes.
It wants to send data to, or reach, anything other than the allowlisted hosts —
an attacker's server, the cloud metadata endpoint, the Docker host, other
containers, the worker's internal services.

**Assumed:** the sandbox has no other network path (the `--internal` network is
the worker's responsibility); the proxy's own DNS resolver and the allowlisted
services are not attacker-controlled; the attacker cannot change the proxy's
environment.

What the proxy does about it:

| Attack | Defence |
|---|---|
| CONNECT to an arbitrary host | Exact `(host, port)` allowlist; default deny. The name is not even resolved unless allowlisted |
| Plain-HTTP proxying, absolute-form `GET`, any other method | `405`. CONNECT is the only thing implemented |
| IP-literal targets, incl. `127.1`, `0x7f.1`, `0177.0.0.1`, `2130706433`, `[::1]`, `[::ffff:127.0.0.1]` | Always `403`, regardless of allowlist or `ALLOW_PRIVATE_UPSTREAMS`. Any host whose last label is numeric or `0x…` is treated as a literal, so nothing that `inet_aton`/`getaddrinfo` would read as an address ever reaches the resolver |
| DNS rebinding / an allowlisted name pointing at internal space | After resolution every address is classified; loopback, RFC 1918, link-local (incl. `169.254.169.254`), CGNAT, `0.0.0.0/8`, multicast, reserved, documentation/benchmark ranges, IPv6 loopback/unspecified/ULA/link-local/site-local/multicast, and everything outside IPv6 global unicast are never dialled. IPv4-mapped and NAT64 addresses are judged by their embedded IPv4 address; 6to4 and Teredo are blocked outright |
| Resolve-then-re-resolve (TOCTOU) | One resolution per CONNECT; the socket is opened to the validated IP, never to the name again |
| Request smuggling / header tricks | Exactly one request head is read (up to the first `CRLF CRLF`, max 8192 bytes) and parsed strictly. Bytes after it are opaque tunnel payload for the already-approved upstream, never a second request. `Host`, `Proxy-Authorization` and every other header are ignored and **nothing from the head is forwarded upstream** |
| Slowloris / socket exhaustion | Whole-head deadline, hard connection cap, connect deadline, idle timeout on tunnels |
| Log injection | Hand-rolled JSON encoder, tested against `serde_json` for every control character; field length cap |
| Unicode / look-alike hosts | Hostnames must be ASCII letters, digits, hyphen and dot; anything else is `400` |

## What it does NOT do

Read this before relying on it.

- **No TLS interception. The proxy cannot see or filter what is sent to an
  allowlisted host.** A tunnel to `github.com` or `api.anthropic.com` is opaque.
  Data can therefore be exfiltrated *to an allowlisted host*: pushed to an
  attacker-owned repository or gist on GitHub, placed in an issue or commit
  message, or embedded in an API prompt sent with an attacker's own API key.
  The allowlist limits *where* bytes can go, not *what* they are or *whose
  account* receives them. Mitigations live elsewhere: scope the sandbox's git
  credentials to one repository, do not put secrets in the sandbox, and treat
  everything the sandbox can read as disclosable to every allowlisted service.
- **No SNI / Host verification inside the tunnel.** The proxy connects to an IP
  that the allowlisted name resolved to, but does not check that the TLS
  ClientHello names the same host. If an allowlisted name is served by a shared
  CDN or load balancer, a client may be able to reach *another tenant on the
  same edge IPs* by sending a different SNI/Host ("domain fronting"), subject
  to that provider's own policy. Keep the allowlist to hosts where this is
  acceptable, or add SNI pinning in front of this proxy.
- **Tunnels are not restricted to TLS or HTTP.** Whatever protocol the
  allowlisted `host:port` speaks is reachable. Allowlisting `github.com:22`
  allows SSH to GitHub.
- **No volume, rate, or lifetime limits.** There is a concurrency cap and an
  idle timeout, but no byte quota, no bandwidth limit and no maximum tunnel
  duration. `bytes_up` in the `close` line is the place to alert on volume.
  Denied requests are logged one line each without rate limiting, so a hostile
  sandbox can generate log volume; cap it at the Docker log driver
  (`--log-opt max-size=…`).
- **No authentication.** Anything that can reach port 3128 can use the
  allowlist. Only attach the proxy to the sandbox network; do not publish the
  port.
- **No DNS service for the sandbox.** The sandbox never needs to resolve
  external names (the proxy does it), and should not be given a resolver that
  forwards to the internet — DNS queries are an exfiltration channel that this
  proxy cannot see. On current Docker, containers attached only to an
  `--internal` network cannot resolve external names; `test-e2e.sh` checks this.
- **It does not create the isolation.** If the sandbox container is attached to
  any non-internal network, has `--network host`, or can reach the Docker
  socket, the proxy is bypassed. That is the worker's job to get right.
- **It trusts its resolver.** The address guard stops a poisoned answer from
  pointing an allowlisted name at internal space, but not at an attacker's
  public IP. (The TLS certificate check in the client still applies there.)
- **Wildcards are as broad as they look.** `*.githubusercontent.com` allows
  every host under it, including ones serving user-controlled content.
- No HTTP/2 or HTTP/3 to the proxy, no `Proxy-Authorization`, no PAC, no
  caching, no upstream proxy chaining, no IPv6-literal targets.

## Running

```sh
docker build -t agentfund/egress-proxy:dev .
# multi-arch
docker buildx build --platform linux/amd64,linux/arm64 -t agentfund/egress-proxy:dev .
```

Sidecar wiring (what the worker does, in shell form):

```sh
docker network create --internal sandbox-net

docker create --name egress --network bridge \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e ALLOW_HOSTS=api.anthropic.com,github.com \
  agentfund/egress-proxy:dev
docker network connect --alias proxy sandbox-net egress
docker start egress

docker run --rm --network sandbox-net \
  -e HTTPS_PROXY=http://proxy:3128 -e https_proxy=http://proxy:3128 \
  <sandbox-image> …
```

The image has no shell, no libc, no CA bundle (it only tunnels, it never speaks
TLS itself) and no writable paths. `HEALTHCHECK` runs
`/egress-proxy --healthcheck`, which performs `GET /healthz` against the local
listener (it honours `LISTEN_ADDR`).

Git over HTTPS and the Anthropic SDKs honour `HTTPS_PROXY`. Git over SSH does
not go through an HTTP proxy without extra client configuration; prefer HTTPS
remotes.

## Tests

There is no need for a local Rust toolchain; everything runs in Docker. From
this directory:

```sh
# format, lint, unit + integration tests
docker run --rm -v "$PWD":/src -w /src -e CARGO_TARGET_DIR=/tmp/target rust:1-slim sh -c '
  rustup component add rustfmt clippy &&
  cargo fmt --check &&
  cargo clippy --all-targets --locked -- -D warnings &&
  cargo test --locked'

# only the pure-logic unit tests / only the socket-level integration tests
docker run --rm -v "$PWD":/src -w /src -e CARGO_TARGET_DIR=/tmp/target rust:1-slim cargo test --locked --lib
docker run --rm -v "$PWD":/src -w /src -e CARGO_TARGET_DIR=/tmp/target rust:1-slim cargo test --locked --test integration

# end to end with real Docker networking (needs internet from the Docker host)
./test-e2e.sh
```

`CARGO_TARGET_DIR=/tmp/target` keeps Linux build artefacts out of the mounted
source tree. Add `-v egress-proxy-cargo:/usr/local/cargo/registry -v
egress-proxy-target:/tmp/target` to cache between runs.

- **Unit tests** (`src/*.rs`): allowlist parsing and matching (wildcard, apex,
  case, trailing dot, port, every malformed form), IP-literal detection
  (dotted, short, decimal, hex, octal, bracketed and bare IPv6, IPv4-mapped),
  address classification at every range boundary plus a sweep of all IPv4
  /16s against an independent table, request-head parsing (malformed request
  lines, headers, targets, control bytes, size limit), config parsing, JSON
  encoding.
- **Integration tests** (`tests/integration.rs`): the real server on loopback
  sockets with an in-process echo upstream and an injected resolver. The
  private-upstream switch is set on the `Config` struct, never through the
  environment. Covers: bytes both ways, no head bytes forwarded, pipelined
  bytes not re-parsed, 403/405/400/431/408/503/502/504, IP literals, the
  rebinding guard for each internal range, single resolution, connection cap,
  slow headers, idle timeout, graceful shutdown.
- **`test-e2e.sh`**: creates an `--internal` network, runs the built image on
  it and on the bridge, and drives it with `curlimages/curl` from a container
  that is on the internal network only. Uses unique names and removes
  everything on exit.

## Layout

```
src/host.rs       hostname normalisation, IP-literal detection   (pure)
src/allowlist.rs  ALLOW_HOSTS parsing and matching               (pure)
src/ipclass.rs    resolved-address classification                (pure)
src/request.rs    request-head parsing                           (pure)
src/config.rs     environment → Config (lookup fn injected)      (pure)
src/log.rs        JSON lines, RFC 3339 timestamps, sinks
src/proxy.rs      accept loop, decision sequencing, tunnel       (I/O)
src/main.rs       CLI, signals, --healthcheck
tests/integration.rs
test-e2e.sh
Dockerfile
```
