#!/bin/sh
# End-to-end acceptance loop against a mock agent. Spends no real tokens.
#
#   real server (Postgres in Docker)  +  real worker binary  +  real sandbox and egress proxy
#   + a signed file:// project made from examples/hello-project
#   + sandbox image whose `claude` is worker/cmd/mock-agent
#
# Proves: approve → claim → verify signature → sandbox run → scope check → branch pushed →
# report → CI result → delivered → merge → merged, the dependent task unlocking, and the SSE
# counter moving while the worker runs.
#
# Needs: docker, node 22 + pnpm, go, git, curl, openssl.   Usage: sh scripts/e2e.sh [--keep]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEEP=${1:-}
RUN_ID="afe2e-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/$RUN_ID.XXXXXX")
PORT=${E2E_PORT:-18787}
BASE="http://127.0.0.1:$PORT"
SECRET="e2e-webhook-secret-0123456789"
PG="$RUN_ID-pg"
SERVER_PID=""
SSE_PID=""

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; [ -f "$WORK/server.log" ] && tail -n 40 "$WORK/server.log" >&2; exit 1; }

cleanup() {
  code=$?
  [ -n "$SSE_PID" ] && kill "$SSE_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  docker rm -f "$PG" >/dev/null 2>&1 || true
  if [ "$KEEP" = "--keep" ] || [ $code -ne 0 ]; then
    echo "work dir kept: $WORK"
  else
    rm -rf "$WORK"
  fi
  exit $code
}
trap cleanup EXIT INT TERM

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=(new Function("v","return "+process.argv[1]))(v);console.log(typeof r==="object"?JSON.stringify(r):r)})' "$1"; }
api()  { # method path [body] [token]
  if [ -n "${3:-}" ]; then
    curl -fsS -X "$1" "$BASE$2" -H 'content-type: application/json' ${4:+-H "authorization: Bearer $4"} -d "$3"
  else
    curl -fsS -X "$1" "$BASE$2" ${4:+-H "authorization: Bearer $4"}
  fi
}
ci_result() { # json body → signed generic CI webhook
  sig=$(printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
  curl -fsS -X POST "$BASE/v1/webhooks/ci" -H 'content-type: application/json' \
    -H "X-AgentFund-Signature: sha256=$sig" -d "$1"
}
wait_for() { # description, command...
  desc=$1; shift; i=0
  until "$@" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 120 ] && fail "timed out waiting for $desc"; sleep 0.5; done
}

say "build"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null)
(cd "$ROOT" && pnpm --filter web build >/dev/null && pnpm --filter server build >/dev/null)
(cd "$ROOT/worker" && make build >/dev/null && make e2e-images >/dev/null)
docker image inspect agentfund/egress-proxy:dev >/dev/null 2>&1 || docker build -q -t agentfund/egress-proxy:dev "$ROOT/images/egress-proxy" >/dev/null
AF="$ROOT/worker/bin/agentfund"
ok "server, web, worker binary, mock-agent sandbox image, egress proxy"

say "signed file:// project from examples/hello-project"
REPO="$WORK/hello-project"
cp -R "$ROOT/examples/hello-project" "$REPO"
REPO_URL="file://$REPO"
KEY="$REPO/.example-key/example.key"
cp "$KEY" "$WORK/maintainer.key"; rm -rf "$REPO/.example-key"
sed -i.bak -e "s|^repo_url:.*|repo_url: $REPO_URL|" -e "s|^ci_provider:.*|ci_provider: generic|" "$REPO/agentfund.yaml" && rm "$REPO/agentfund.yaml.bak"
"$AF" validate "$REPO/tasks" >/dev/null
"$AF" sign "$REPO/tasks" --key "$WORK/maintainer.key" >/dev/null
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=maintainer -c user.email=m@example.test add -A
git -C "$REPO" -c user.name=maintainer -c user.email=m@example.test commit -qm "chore: signed task set"
HEAD0=$(git -C "$REPO" rev-parse HEAD)
ok "repo at $HEAD0"

say "server"
docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD=e2e -e POSTGRES_DB=agentfund -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
wait_for "postgres" docker exec "$PG" pg_isready -U postgres
PGPORT=$(docker port "$PG" 5432/tcp | head -n1 | sed 's/.*://')
(
  cd "$ROOT/server"
  PORT=$PORT BASE_URL=$BASE DATABASE_URL="postgres://postgres:e2e@127.0.0.1:$PGPORT/agentfund" \
  AUTH_DEV_LOGIN=true ALLOW_FILE_REPOS=true WEBHOOK_SECRET=$SECRET DATA_DIR="$WORK/server-data" \
  INDEX_INTERVAL_SECONDS=2 SWEEP_INTERVAL_SECONDS=2 INSTANCE_NAME="E2E Instance" LOG_LEVEL=warn \
  exec node dist/main.js
) >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
wait_for "server /healthz" curl -fsS "$BASE/healthz"
META=$(api GET /v1/meta)
[ "$(echo "$META" | json 'v.protocol_versions.includes("v1") && v.spec_versions.includes(1)')" = "true" ] || fail "meta negotiation"
ok "up at $BASE — $(echo "$META" | json 'v.name+" / "+v.app+" "+v.version')"

say "accounts, API key, project"
MAINT=$(api POST /v1/auth/dev '{"handle":"maintainer"}' | json 'v.token')
DONOR=$(api POST /v1/auth/dev '{"handle":"donor"}' | json 'v.token')
AF_KEY=$(api POST /v1/me/api-keys '{"label":"e2e worker"}' "$DONOR" | json 'v.key')
PREVIEW=$(api POST /v1/projects/preview "{\"repo_url\":\"$REPO_URL\"}" "$MAINT")
[ "$(echo "$PREVIEW" | json 'v.ok && v.signature_valid && v.manifests.length===3')" = "true" ] || fail "preview: $PREVIEW"
PROJECT=$(api POST /v1/projects "{\"repo_url\":\"$REPO_URL\",\"slug\":\"hello\"}" "$MAINT")
[ "$(echo "$PROJECT" | json 'v.pinned_commit')" = "$HEAD0" ] || fail "project not pinned at head"
FPR=$(echo "$PROJECT" | json 'v.pubkey_fingerprint')
ok "project hello pinned, key $FPR"
api POST /v1/projects/hello/pledges '{"token_amount":3000000}' "$DONOR" >/dev/null
[ "$(api GET /v1/projects/hello | json 'v.totals.pledged')" = "3000000" ] || fail "pledge not counted"
ok "pledged 3,000,000"
[ "$(api GET '/v1/projects/hello/tasks?claimable=true' | json 'v.items.map(t=>t.task_id).join(",")')" = "0001-slugify" ] || fail "only 0001 should be claimable (dependency gating)"
ok "dependency gating: only 0001-slugify is claimable"

say "worker: login, approve, dry-run"
export AGENTFUND_CONFIG_DIR="$WORK/donor-config" AGENTFUND_DATA_DIR="$WORK/donor-data"
export AGENTFUND_SANDBOX_IMAGE=agentfund/sandbox-e2e:happy AGENTFUND_EGRESS_PROXY_IMAGE=agentfund/egress-proxy:dev
export CLAUDE_CODE_OAUTH_TOKEN="e2e-not-a-real-credential"   # the mock agent never calls a model
mkdir -p "$AGENTFUND_CONFIG_DIR"
cat >"$AGENTFUND_CONFIG_DIR/config.yaml" <<EOF
global:
  allowed_git_hosts: [github.com, file]
  schedule: []
EOF
printf '%s\n' "$AF_KEY" | "$AF" login "$BASE" --key-stdin >/dev/null
"$AF" approve "$BASE/hello" --yes --no-pager >"$WORK/approve.txt" 2>&1 || { cat "$WORK/approve.txt"; fail "approve"; }
grep -q "$FPR" "$WORK/approve.txt" || fail "approve did not show the fingerprint the server publishes"
ok "approved; fingerprint matches the server's Audit value"
"$AF" dry-run hello -n 3 >"$WORK/dry-run.txt" 2>&1 || { cat "$WORK/dry-run.txt"; fail "dry-run"; }
grep -q "0001-slugify" "$WORK/dry-run.txt" || fail "dry-run did not list 0001-slugify"
ok "dry-run lists 0001-slugify"

say "worker: run one task (live counter watched over SSE)"
curl -fsSN "$BASE/v1/stream?project=hello" >"$WORK/sse.txt" 2>/dev/null &
SSE_PID=$!
sleep 1
"$AF" work hello --once --json >"$WORK/work.json" 2>"$WORK/work.err" || { cat "$WORK/work.err"; cat "$WORK/work.json"; fail "work --once"; }
sleep 2; kill "$SSE_PID" 2>/dev/null || true; SSE_PID=""
RESULT=$(tail -n 1 "$WORK/work.json")
[ "$(echo "$RESULT" | json 'v.outcome')" = "completed" ] || fail "outcome: $RESULT"
BRANCH=$(echo "$RESULT" | json 'v.branch'); SHA=$(echo "$RESULT" | json 'v.head_sha')
TOKENS=$(echo "$RESULT" | json 'v.tokens_in+v.tokens_out')
ok "completed: $TOKENS tokens, branch $BRANCH"
git -C "$REPO" rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null || fail "branch was not pushed to the project repo"
[ "$(git -C "$REPO" rev-parse "refs/heads/$BRANCH")" = "$SHA" ] || fail "pushed head differs from reported head_sha"
CHANGED=$(git -C "$REPO" diff --name-only "$HEAD0" "$BRANCH" | sort | tr '\n' ' ')
[ "$CHANGED" = "src/textutil.py tests/test_slugify.py " ] || fail "diff outside scope.write: $CHANGED"
ok "pushed diff is exactly the task's write scope: $CHANGED"
FRAMES=$(grep -c '^event: totals' "$WORK/sse.txt" || true)
DISTINCT=$(grep '^data: ' "$WORK/sse.txt" | grep '"totals"' | sort -u | wc -l | tr -d ' ')
[ "$DISTINCT" -ge 2 ] || fail "SSE counter did not move during the run ($FRAMES frames, $DISTINCT distinct)"
ok "SSE: $FRAMES totals frames, $DISTINCT distinct values — the counter moved"
LOGFILE=$(echo "$RESULT" | json 'v.log_file'); DIGEST=$(echo "$RESULT" | json 'v.log_digest')
if grep -rq "e2e-not-a-real-credential" "$AGENTFUND_DATA_DIR" "$WORK/work.json" "$WORK/server.log"; then fail "credential leaked into logs"; fi
ok "credential appears in no log, report or server log"

say "ledger: reported, not yet delivered"
T=$(api GET /v1/projects/hello | json 'v.totals')
[ "$(echo "$T" | json 'v.reported')" = "$TOKENS" ] || fail "reported != worker tokens: $T"
[ "$(echo "$T" | json 'v.delivered')" = "0" ] || fail "delivered before CI: $T"
[ "$(api GET /v1/tasks/hello:0001-slugify | json 'v.state+"/"+v.latest_report.delivery')" = "claimed/pending_ci" ] || fail "task should await CI"
[ "$(api GET /v1/tasks/hello:0001-slugify | json 'v.latest_report.log_digest')" = "$DIGEST" ] || fail "log digest mismatch"
ok "reported=$TOKENS delivered=0; task awaits CI; public log_digest matches the worker's"

say "CI: forged, wrong-commit and genuine results"
BODY="{\"provider\":\"generic\",\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"head_sha\":\"$SHA\",\"conclusion\":\"success\"}"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/webhooks/ci" -H 'content-type: application/json' -H 'X-AgentFund-Signature: sha256=00' -d "$BODY")
[ "$CODE" = "401" ] || fail "forged CI result accepted ($CODE)"
ok "forged signature rejected (401)"
WRONG="{\"provider\":\"generic\",\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"head_sha\":\"$HEAD0\",\"conclusion\":\"success\"}"
ci_result "$WRONG" >/dev/null
[ "$(api GET /v1/projects/hello | json 'v.totals.delivered')" = "0" ] || fail "CI result for a different commit delivered the report"
ok "result for a different commit does not deliver"
[ "$(ci_result "$BODY" | json 'v.matched')" = "true" ] || fail "genuine CI result did not match"
T=$(api GET /v1/projects/hello | json 'v.totals')
[ "$(echo "$T" | json 'v.delivered')" = "$TOKENS" ] || fail "not delivered after CI: $T"
[ "$(api GET /v1/tasks/hello:0001-slugify | json 'v.state')" = "delivered" ] || fail "task not delivered"
[ "$(api GET /v1/donors/donor | json 'v.delivered+"/"+v.tasks_delivered')" = "$TOKENS/1" ] || fail "donor profile"
ok "delivered=$TOKENS; task delivered; donor profile updated"

say "merge: PR merges, dependent task unlocks"
git -C "$REPO" -c user.name=maintainer -c user.email=m@example.test merge -q --no-ff "$BRANCH" -m "Merge $BRANCH"
ci_result "{\"provider\":\"generic\",\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"head_sha\":\"$SHA\",\"conclusion\":\"success\",\"merged\":true}" >/dev/null
T=$(api GET /v1/projects/hello | json 'v.totals')
[ "$(echo "$T" | json 'v.merged')" = "$TOKENS" ] || fail "not merged: $T"
ok "merged=$TOKENS"
HEAD1=$(git -C "$REPO" rev-parse HEAD)
pinned() { [ "$(api GET /v1/projects/hello | json 'v.pinned_commit')" = "$HEAD1" ]; }
wait_for "indexer to follow the branch to $HEAD1" pinned
[ "$(api GET '/v1/projects/hello/tasks?claimable=true' | json 'v.items.map(t=>t.task_id).join(",")')" = "0002-truncate" ] || fail "0002 should now be claimable"
ok "indexer followed the signed head; 0002-truncate is now claimable"

say "approval pin: the worker refuses the new commit until re-approved"
set +e; "$AF" work hello --once --json >"$WORK/work2.json" 2>"$WORK/work2.err"; RC=$?; set -e
[ $RC -ne 0 ] || fail "worker ran a commit the donor never approved"
[ "$(api GET /v1/projects/hello | json 'v.totals.reported')" = "$TOKENS" ] || fail "tokens were burned on an unapproved commit"
ok "refused (exit $RC), nothing executed, no tokens burned"
"$AF" approve "$BASE/hello" --yes --no-pager >/dev/null 2>&1
"$AF" work hello --once --json >"$WORK/work3.json" 2>"$WORK/work3.err" || { cat "$WORK/work3.err"; fail "second task after re-approval"; }
[ "$(tail -n 1 "$WORK/work3.json" | json 'v.outcome+" "+v.task')" = "completed hello:0002-truncate" ] || [ "$(tail -n 1 "$WORK/work3.json" | json 'v.outcome')" = "completed" ] || fail "second task: $(tail -n 1 "$WORK/work3.json")"
ok "after re-approval the dependent task ran and completed"

say "tampering: a changed manifest without a new signature is never indexed"
printf '\n# tampered\n' >>"$REPO/tasks/0003-cli.yaml"
git -C "$REPO" -c user.name=attacker -c user.email=a@example.test commit -qam "tamper"
HEAD2=$(git -C "$REPO" rev-parse HEAD)
set +e; api POST /v1/projects/hello/repin "{\"commit\":\"$HEAD2\"}" "$MAINT" >/dev/null 2>&1; RC=$?; set -e
[ $RC -ne 0 ] || fail "server pinned a commit whose lock does not match"
[ "$(api GET /v1/projects/hello | json 'v.pinned_commit')" = "$HEAD1" ] || fail "pin moved to a tampered commit"
ok "server refused; pin unchanged"

say "public surfaces"
for p in /v1/stats /v1/projects /v1/projects/hello/ledger /v1/projects/hello/events /v1/donors /v1/events /sitemap.xml /feed.atom /og/hello.png / /hello /u/donor; do
  curl -fsS -o /dev/null "$BASE$p" || fail "GET $p"
done
curl -fsS "$BASE/hello" | grep -qi 'og:title' || fail "project page has no injected OpenGraph tags"
[ "$(api GET /v1/projects/hello/events | json 'v.items.some(e=>e.action==="task.delivered") && v.items.some(e=>e.action==="task.merged")')" = "true" ] || fail "audit log is missing delivery/merge events"
ok "API reads, sitemap, feed, OG image, SPA with injected meta, audit events"

printf '\n\033[1;32mE2E PASSED\033[0m  claim → verify → sandbox → PR branch → CI → delivered → merged, counter moved, tampering refused.\n'
