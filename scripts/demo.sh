#!/bin/sh
# The whole loop on your machine, with zero tokens.
#
#   real server (Postgres in Docker)  +  real `agentfund` worker  +  real sandbox and egress proxy
#   + a signed sample project (examples/hello-project, served from a file:// repo)
#   + a sandbox image whose `claude` is a scripted mock, so no model is ever called
#
#   sh scripts/demo.sh            guided: start everything, run two tasks, leave it up to explore
#   sh scripts/demo.sh --manual   start everything, then you type the worker commands yourself
#   sh scripts/demo.sh ci         in a second terminal: play CI for the run awaiting it (pass, then merge)
#   sh scripts/demo.sh down       clean up after a demo that was killed rather than Ctrl-C'd
#
# Environment: DEMO_PORT (default 8787), NO_OPEN=1 (do not open a browser), DEMO_PACE (seconds
# to pause between steps so you can watch the page, default 3), DEMO_DIR (state directory,
# default .demo/ in the repo; `ci` and `down` need the same value).
#
# Needs: docker (running), node 22 + pnpm, go, git, curl, openssl. Everything it creates lives
# in .demo/ and one Postgres container; Ctrl-C removes both.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE=${1:-guided}
WORK=${DEMO_DIR:-$ROOT/.demo}
case "$WORK" in "$ROOT"/*) SHOW=${WORK#"$ROOT"/} ;; *) SHOW=$WORK ;; esac   # how we print it
PORT=${DEMO_PORT:-8787}
BASE="http://localhost:$PORT"
PG="agentfund-demo-pg"
PACE=${DEMO_PACE:-3}

. "$ROOT/scripts/lib.sh"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n' "$*"; }
run()  { printf '\n\033[2m$\033[0m \033[1m%s\033[0m\n' "$*"; "$@"; }
totals() { api GET /v1/projects/hello | json '"  pledged "+v.totals.pledged.toLocaleString("en")+" · reported "+v.totals.reported.toLocaleString("en")+" · delivered "+v.totals.delivered.toLocaleString("en")+" · merged "+v.totals.merged.toLocaleString("en")'; }

# Play the CI provider for the one report awaiting a result: a passing run (reported → delivered),
# then the maintainer's merge (delivered → merged), which unlocks dependent tasks.
play_ci() {
  PENDING=$(api GET /v1/projects/hello/tasks | json 'v.items.map(t=>t.latest_report).find(r=>r&&r.delivery==="pending_ci")||""')
  [ -n "$PENDING" ] || { echo "No run is waiting for CI. Run \`agentfund work hello --once\` first." >&2; return 1; }
  BRANCH=$(echo "$PENDING" | json 'v.branch'); SHA=$(echo "$PENDING" | json 'v.head_sha')
  BODY="{\"provider\":\"generic\",\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"head_sha\":\"$SHA\""
  ci_result "$BODY,\"conclusion\":\"success\"}" >/dev/null
  note "CI passed on $BRANCH"; note "$(totals)"
  sleep "$PACE"
  git -C "$REPO" -c user.name=maintainer -c user.email=m@example.test merge -q --no-ff "$BRANCH" -m "Merge $BRANCH"
  ci_result "$BODY,\"conclusion\":\"success\",\"merged\":true}" >/dev/null
  HEAD1=$(git -C "$REPO" rev-parse HEAD)
  pinned() { [ "$(api GET /v1/projects/hello | json 'v.pinned_commit')" = "$HEAD1" ]; }
  wait_for "the indexer to follow main" pinned
  # Dependents open on the first good read of the branch after the merge was recorded.
  landed() { [ "$(api GET /v1/projects/hello/tasks | json 'v.items.every(t=>t.blocked_by.every(d=>v.items.find(x=>x.task_id===d).state!=="merged"))')" = true ]; }
  wait_for "merged dependencies to unlock their tasks" landed
  note "merged into main; the indexer followed the signed head"; note "$(totals)"
}

case "$MODE" in
  ci)
    [ -f "$WORK/state" ] || { echo "No demo is running. Start one with: sh scripts/demo.sh --manual" >&2; exit 1; }
    . "$WORK/state"
    play_ci
    exit 0 ;;
  down)
    if [ -f "$WORK/server.pid" ]; then kill "$(cat "$WORK/server.pid")" 2>/dev/null || true; fi
    docker rm -f "$PG" >/dev/null 2>&1 || true
    rm -rf "$WORK"
    echo "Demo stopped and $SHOW/ removed."
    exit 0 ;;
  guided|--manual) ;;
  -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "usage: sh scripts/demo.sh [--manual | ci | down]" >&2; exit 2 ;;
esac

lib_need docker node pnpm go git curl openssl
if curl -fsS -o /dev/null "$BASE/healthz" 2>/dev/null || [ -d "$WORK" ]; then
  echo "Something already answers on $BASE, or $SHOW/ exists from an earlier run." >&2
  echo "Stop it with \`sh scripts/demo.sh down\`, or pick another port: DEMO_PORT=8788 sh scripts/demo.sh" >&2
  exit 1
fi
mkdir -p "$WORK"

cleanup() {
  code=$?
  trap - EXIT INT TERM
  lib_stop
  rm -rf "$WORK"
  printf '\nDemo stopped. Postgres container and %s/ removed.\n' "$SHOW"
  exit $code
}
trap cleanup EXIT INT TERM

T0=$(date +%s)
step "1/4  Build"
dim "  server, web UI, worker binary, mock-agent sandbox image, egress proxy (first run: a few minutes)"
lib_build happy
note "built in $(( $(date +%s) - T0 ))s"

step "2/4  A signed project"
lib_sample_project
note "examples/hello-project → $REPO_URL"
note "3 task manifests, one signature over tasks/MANIFEST.lock, commit $(echo "$HEAD0" | cut -c1-12)"

step "3/4  An instance"
lib_start_server "Local demo"
echo "$SERVER_PID" >"$WORK/server.pid"
lib_accounts_and_project
api POST /v1/projects/hello/pledges '{"token_amount":3000000}' "$DONOR" >/dev/null
lib_worker_env
cat >"$WORK/state" <<EOF
REPO='$REPO'
REPO_URL='$REPO_URL'
SECRET='$SECRET'
EOF
cat >"$WORK/env" <<EOF
# Source this to drive the demo worker yourself:  . $SHOW/env
export PATH="$ROOT/worker/bin:\$PATH"
export AGENTFUND_CONFIG_DIR="$AGENTFUND_CONFIG_DIR" AGENTFUND_DATA_DIR="$AGENTFUND_DATA_DIR"
export AGENTFUND_SANDBOX_IMAGE=$AGENTFUND_SANDBOX_IMAGE AGENTFUND_EGRESS_PROXY_IMAGE=$AGENTFUND_EGRESS_PROXY_IMAGE
export CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN   # not a credential; the mock agent calls no model
EOF
note "$BASE  (Postgres in Docker, dev login on: sign in as \"maintainer\" or \"donor\")"
note "project \"hello\" registered, maintainer key $FPR"
note "ready in $(( $(date +%s) - T0 ))s"

if [ -z "${NO_OPEN:-}" ] && [ -z "${CI:-}" ]; then
  if command -v open >/dev/null 2>&1; then open "$BASE/hello"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$BASE/hello" >/dev/null 2>&1 || true; fi
fi

if [ "$MODE" = "--manual" ]; then
  step "4/4  Your turn"
  cat <<EOF
  Open $BASE/hello and keep it visible. In another terminal, from the repo root:

    . $SHOW/env                                   # demo worker config + the mock-agent sandbox image
    agentfund approve $BASE/hello   # fingerprint, every prompt, then you confirm
    agentfund dry-run hello                       # what would run next; runs nothing
    agentfund work hello --once                   # claim → verify → sandbox → push branch → report
    sh scripts/demo.sh ci                         # play CI: pass (delivered), then merge
    agentfund status
    agentfund logs                                # then: agentfund logs <claim>

  Ctrl-C here stops the instance and removes everything.
EOF
  wait "$SERVER_PID"
  exit 0
fi

step "4/4  A backer's worker"
note "Watch $BASE/hello while this runs."
sleep "$PACE"
# --follow-unchanged-lock: keep working after merges as long as the signed task list is byte-identical.
PATH="$ROOT/worker/bin:$PATH"
printf '\n\033[2m$\033[0m \033[1m%s\033[0m\n' "agentfund approve $BASE/hello --yes --follow-unchanged-lock"
agentfund approve "$BASE/hello" --yes --no-pager --follow-unchanged-lock >"$WORK/approve.txt" 2>&1 || { cat "$WORK/approve.txt"; fail "approve"; }
sed -n '/^Maintainer key/,/^Lock:/p' "$WORK/approve.txt"
dim "  (every prompt was printed too: $SHOW/approve.txt)"
sleep "$PACE"

for n in 1 2; do
  run agentfund work hello --once || fail "work --once"
  note "reported, not yet delivered"; note "$(totals)"
  sleep "$PACE"
  play_ci
  sleep "$PACE"
done

run agentfund status

ELAPSED=$(( $(date +%s) - T0 ))
cat <<EOF

$(printf '\033[1;32mDone in %ss.\033[0m' "$ELAPSED") Two tasks claimed, verified, sandboxed, pushed, passed by CI and merged. No tokens spent.
The third task (0003-cli) is still open: the mock agent only knows two tricks.

  Look around      $BASE/hello          the board, the ledger, the Audit tab
                   $BASE/u/donor        what a backer's public profile shows
  Read the run     . $SHOW/env && agentfund logs    then: agentfund logs <claim>
  See the diff     git -C $SHOW/hello-project log --oneline --graph
  Verify the lock  minisign -Vm $SHOW/hello-project/tasks/MANIFEST.lock -P "\$(sed -n 's/^pubkey: //p' $SHOW/hello-project/agentfund.yaml)"

  Next: docs/quickstart.md takes this from a mock agent to a real one.

Ctrl-C stops the instance and removes everything.
EOF
wait "$SERVER_PID"
