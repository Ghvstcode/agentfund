#!/bin/sh
# The whole loop with a REAL coding agent, on your machine, under your own key.
#
#   ANTHROPIC_API_KEY=sk-ant-…   sh scripts/trial.sh          # Claude Code (or CLAUDE_CODE_OAUTH_TOKEN)
#   RUNNER=codex OPENAI_API_KEY=sk-…  sh scripts/trial.sh     # Codex (experimental; or CODEX_API_KEY)
#
# Same local instance and signed sample project as `make demo`, but the sandbox image is the real
# one (images/sandbox: the unmodified agent CLIs), so the agent really calls the model and the
# tokens are really spent: one task of examples/hello-project (0001-slugify, a small Python
# function with tests), capped at 1M tokens by its manifest. A typical run is far below that.
# If `verify` passes, the script plays CI (delivered) and merges (merged), like the demo.
#
# Environment: RUNNER (claude-code | codex, default claude-code), MODEL (passed as --model;
# e.g. MODEL=sonnet to keep it cheap), TASK (default 0001-slugify), TRIAL_PORT (default 8788),
# SANDBOX_IMAGE / EGRESS_PROXY_IMAGE (default agentfund/sandbox:dev, agentfund/egress-proxy:dev;
# built from images/ when missing), TRIAL_DIR (state directory, default .trial/ in the repo).
#
# Needs: docker (running), node 22 + pnpm, go, git, curl, openssl. Ctrl-C removes everything.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${TRIAL_DIR:-$ROOT/.trial}
PORT=${TRIAL_PORT:-8788}
BASE="http://localhost:$PORT"
PG="agentfund-trial-pg"
RUNNER=${RUNNER:-claude-code}
MODEL=${MODEL:-}
TASK=${TASK:-0001-slugify}
USER_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}   # lib_worker_env overwrites it with the mock's placeholder
SANDBOX_IMAGE=${SANDBOX_IMAGE:-agentfund/sandbox:dev}
EGRESS_PROXY_IMAGE=${EGRESS_PROXY_IMAGE:-agentfund/egress-proxy:dev}

. "$ROOT/scripts/lib.sh"
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
totals() { api GET /v1/projects/hello | json '"  pledged "+v.totals.pledged.toLocaleString("en")+" · reported "+v.totals.reported.toLocaleString("en")+" · delivered "+v.totals.delivered.toLocaleString("en")+" · merged "+v.totals.merged.toLocaleString("en")'; }

case "$RUNNER" in
  claude-code) [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`)." >&2; exit 2; } ;;
  codex) [ -n "${OPENAI_API_KEY:-}${CODEX_API_KEY:-}" ] || { echo "Set OPENAI_API_KEY or CODEX_API_KEY." >&2; exit 2; } ;;
  *) echo "RUNNER must be claude-code or codex, not $RUNNER" >&2; exit 2 ;;
esac
lib_need docker node pnpm go git curl openssl
if curl -fsS -o /dev/null "$BASE/healthz" 2>/dev/null || [ -d "$WORK" ]; then
  echo "Something already answers on $BASE, or $WORK exists from an earlier run. Remove it or set TRIAL_PORT / TRIAL_DIR." >&2
  exit 1
fi
mkdir -p "$WORK"
cleanup() { code=$?; trap - EXIT INT TERM; lib_stop; rm -rf "$WORK"; printf '\nTrial stopped. Postgres container and %s removed.\n' "$WORK"; exit $code; }
trap cleanup EXIT INT TERM

step "1/4  Build"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter web build >/dev/null && pnpm --filter server build >/dev/null)
(cd "$ROOT/worker" && make build >/dev/null)
AF="$ROOT/worker/bin/agentfund"
docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1 || { note "building $SANDBOX_IMAGE (first run: several minutes)"; docker build -q -t "$SANDBOX_IMAGE" "$ROOT/images/sandbox" >/dev/null; }
docker image inspect "$EGRESS_PROXY_IMAGE" >/dev/null 2>&1 || docker build -q -t "$EGRESS_PROXY_IMAGE" "$ROOT/images/egress-proxy" >/dev/null
note "agent: $RUNNER $(docker run --rm "$SANDBOX_IMAGE" sh -c "$( [ "$RUNNER" = codex ] && echo 'codex --version' || echo 'claude --version' )" 2>/dev/null | tail -n1)"

step "2/4  Instance and signed project"
lib_sample_project
lib_start_server "Real-model trial"
lib_accounts_and_project
api POST /v1/projects/hello/pledges '{"token_amount":3000000}' "$DONOR" >/dev/null
lib_worker_env
export AGENTFUND_SANDBOX_IMAGE="$SANDBOX_IMAGE" AGENTFUND_EGRESS_PROXY_IMAGE="$EGRESS_PROXY_IMAGE"
if [ -n "$USER_OAUTH_TOKEN" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$USER_OAUTH_TOKEN"; else unset CLAUDE_CODE_OAUTH_TOKEN; fi
# A failed attempt must be retryable at once here, and the runner is the one asked for.
sed -i.bak "/^global:/a\\
  retry_failed_after: \"0\"\\
  runner: {name: $RUNNER, model: \"$MODEL\"}" "$AGENTFUND_CONFIG_DIR/config.yaml" && rm "$AGENTFUND_CONFIG_DIR/config.yaml.bak"
"$AF" approve "$BASE/hello" --yes --no-pager >"$WORK/approve.txt" 2>&1 || { cat "$WORK/approve.txt"; fail "approve"; }
note "$BASE/hello  (sign in as \"maintainer\" or \"donor\")"

step "3/4  One task, real model: $TASK"
T0=$(date +%s)
set +e
"$AF" work hello --once --task "$TASK" --budget 1M --json >"$WORK/result.json"
CODE=$?
set -e
note "worker exit $CODE after $(( $(date +%s) - T0 ))s"
[ -s "$WORK/result.json" ] && json '"  "+v.outcome+" · tokens in "+v.tokens_in+" · out "+v.tokens_out+(v.cost_estimate?" · $"+v.cost_estimate.toFixed(4):"")+(v.reason?" · "+v.reason:"")' <"$WORK/result.json" || true
note "$(totals)"

step "4/4  CI"
PENDING=$(api GET /v1/projects/hello/tasks | json 'v.items.map(t=>t.latest_report).find(r=>r&&r.delivery==="pending_ci")||""')
if [ -n "$PENDING" ]; then
  BRANCH=$(echo "$PENDING" | json 'v.branch'); SHA=$(echo "$PENDING" | json 'v.head_sha')
  BODY="{\"provider\":\"generic\",\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"head_sha\":\"$SHA\""
  ci_result "$BODY,\"conclusion\":\"success\"}" >/dev/null
  git -C "$REPO" -c user.name=maintainer -c user.email=m@example.test merge -q --no-ff "$BRANCH" -m "Merge $BRANCH"
  ci_result "$BODY,\"conclusion\":\"success\",\"merged\":true}" >/dev/null
  note "CI passed and $BRANCH merged"; note "$(totals)"
  note "the agent's change:  git -C $REPO show --stat HEAD^2"
else
  note "nothing reached CI; read the run log below"
fi

cat <<EOF

  Run log    AGENTFUND_CONFIG_DIR=$AGENTFUND_CONFIG_DIR AGENTFUND_DATA_DIR=$AGENTFUND_DATA_DIR $AF logs
  Project    $BASE/hello

Ctrl-C stops the instance and removes everything.
EOF
wait "$SERVER_PID"
