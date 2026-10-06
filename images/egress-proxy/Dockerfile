# syntax=docker/dockerfile:1

# Egress allowlist proxy: static musl binary in a scratch image.
#
# Multi-arch: rust:1-alpine's host target is <arch>-unknown-linux-musl, so a
# plain `cargo build` yields a fully static binary for whatever platform the
# stage runs as. Build both with:
#   docker buildx build --platform linux/amd64,linux/arm64 -t agentfund/egress-proxy:dev .

FROM rust:1-alpine AS build
WORKDIR /src
# musl targets link statically by default (crt-static), which is what lets the
# binary run in `scratch`. Do not set RUSTFLAGS=+crt-static here: without an
# explicit --target it would also apply to proc-macro builds and break them.
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    cargo build --release --locked --bin egress-proxy \
 && cp target/release/egress-proxy /egress-proxy \
 && /egress-proxy --version

FROM scratch
COPY --from=build /egress-proxy /egress-proxy
# Numeric non-root user (no /etc/passwd in scratch). 3128 is unprivileged.
USER 65532:65532
EXPOSE 3128
HEALTHCHECK --interval=10s --timeout=4s --start-period=2s --retries=3 \
    CMD ["/egress-proxy", "--healthcheck"]
ENTRYPOINT ["/egress-proxy"]
