# syntax=docker/dockerfile:1
#
# AgentFund sandbox image: where the coding agent and the manifest's `verify`
# command run. Polyglot on purpose (Python, Node, Rust, Go, C toolchain) so
# common verify commands work without fetching toolchains at run time — the
# sandbox can reach nothing but the model API and the project's git host.
#
# Build:   docker build -t agentfund/sandbox:dev images/sandbox
# Pin:     reference the result by digest in config.yaml
#            sandbox: { image: "agentfund/sandbox@sha256:<digest>" }
#          (docker image inspect --format '{{index .RepoDigests 0}}' after a push,
#          or `docker buildx imagetools inspect <ref>`).
#
# The base image and every tool version below is an explicit ARG. For a
# reproducible release build, pin BASE_IMAGE by digest:
#   --build-arg BASE_IMAGE=node:22-bookworm-slim@sha256:<digest>
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

ARG CLAUDE_CODE_VERSION=2.1.289
ARG GO_VERSION=1.27.1
ARG RUST_TOOLCHAIN=stable
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config \
      python3 python3-venv python3-pip \
      jq less procps unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Go (official tarball, checksum-verified against the published .sha256 list).
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    file="go${GO_VERSION}.linux-${arch}.tar.gz"; \
    curl -fsSLo "/tmp/${file}" "https://go.dev/dl/${file}"; \
    want="$(curl -fsSL "https://go.dev/dl/?mode=json&include=all" | jq -r --arg f "${file}" '.[].files[] | select(.filename==$f) | .sha256' | head -n1)"; \
    test -n "${want}"; \
    echo "${want}  /tmp/${file}" | sha256sum -c -; \
    tar -C /usr/local -xzf "/tmp/${file}"; \
    rm "/tmp/${file}"

# Rust (rustup, minimal profile) installed system-wide and read-only for the agent.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh; \
    sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}"; \
    rm /tmp/rustup-init.sh; \
    chmod -R a+rX /usr/local/rustup /usr/local/cargo

# The coding agent: the unmodified Claude Code CLI from npm, version-pinned.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && claude --version

# Unprivileged user the agent and verify run as. uid/gid must match
# internal/scope (AgentUID/AgentGID) in the worker.
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent --shell /bin/bash agent \
 && mkdir -p /work && chown root:root /work && chmod 0755 /work

# The root file system is mounted read-only at run time; everything a tool
# wants to write goes to the tmpfs home or /tmp. The work tree itself is
# read-only except for the manifest's write scope, so build outputs and
# caches are redirected out of it.
ENV HOME=/home/agent \
    PATH=/usr/local/cargo/bin:/usr/local/go/bin:/home/agent/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    CARGO_HOME=/home/agent/.cargo \
    CARGO_TARGET_DIR=/tmp/cargo-target \
    GOPATH=/home/agent/go \
    GOCACHE=/tmp/go-build \
    GOFLAGS=-buildvcs=false \
    GOTOOLCHAIN=local \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPYCACHEPREFIX=/tmp/pycache \
    PIP_NO_CACHE_DIR=1 \
    npm_config_cache=/tmp/npm-cache \
    npm_config_update_notifier=false \
    DISABLE_AUTOUPDATER=1

USER 10001:10001
WORKDIR /work
# The worker overrides the entrypoint with `sleep infinity` and execs into the
# container; this default only makes `docker run -it` useful for inspection.
CMD ["bash"]
