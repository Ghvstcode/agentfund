#!/bin/sh
# Check every Markdown file in the repository: relative links and #anchors resolve, every
# `agentfund <subcommand> --flag` the docs mention exists in the built CLI's --help, and every
# `make <target>` exists. Needs node and go (it builds worker/bin/agentfund so the check runs
# against the code in this checkout, not an installed release).
#
#   sh scripts/check-docs.sh        (also: make check)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
(cd "$ROOT/worker" && make build >/dev/null)
exec node "$ROOT/scripts/check-docs.mjs"
