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
# Needs: docker, node 22 + pnpm, go, git, curl, openssl.
# Usage: sh scripts/e2e.sh [--keep | --serve]
#   --keep   keep the work directory afterwards
#   --serve  after passing, leave the instance running so you can browse it (Ctrl-C to stop)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEEP=${1:-}
RUN_ID="afe2e-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/$RUN_ID.XXXXXX")
PORT=${E2E_PORT:-18787}
BASE="http://127.0.0.1:$PORT"
OTHER_SECRET="e2e-not-this-projects-secret-0123456789"   # any secret that is not project hello's
PG="$RUN_ID-pg"
SSE_PID=""

. "$ROOT/scripts/lib.sh"   # say/ok/fail, json/api/ci_result/wait_for, lib_* (shared with demo.sh)

cleanup() {
  code=$?
  [ -n "$SSE_PID" ] && kill "$SSE_PID" 2>/dev/null || true
  lib_stop
  if [ "$KEEP" = "--keep" ] || [ $code -ne 0 ]; then
    echo "work dir kept: $WORK"
  else
    rm -rf "$WORK"
  fi
  exit $code
}
trap cleanup EXIT INT TERM

say "build"
lib_need docker node pnpm go git curl openssl
lib_build
ok "server, web, worker binary, mock-agent sandbox image, egress proxy"

say "signed file:// project from examples/hello-project"
lib_sample_project
ok "repo at $HEAD0"

say "server"
lib_start_server "E2E Instance"
META=$(api GET /v1/meta)
[ "$(echo "$META" | json 'v.protocol_versions.includes("v1") && v.spec_versions.includes(1)')" = "true" ] || fail "meta negotiation"
ok "up at $BASE — $(echo "$META" | json 'v.name+" / "+v.app+" "+v.version')"

say "accounts, API key, project"
lib_accounts_and_project
ok "project hello pinned, key $FPR"
api POST /v1/projects/hello/pledges '{"token_amount":3000000}' "$DONOR" >/dev/null
[ "$(api GET /v1/projects/hello | json 'v.totals.pledged')" = "3000000" ] || fail "pledge not counted"
ok "pledged 3,000,000"
[ "$(api GET '/v1/projects/hello/tasks?claimable=true' | json 'v.items.map(t=>t.task_id).join(",")')" = "0001-slugify" ] || fail "only 0001 should be claimable (dependency gating)"
ok "dependency gating: only 0001-slugify is claimable"

say "worker: login, approve, dry-run"
lib_worker_env
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
OTHER_SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$OTHER_SECRET" | sed 's/^.*= //')
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/webhooks/ci" -H 'content-type: application/json' -H "X-AgentFund-Signature: sha256=$OTHER_SIG" -d "$BODY")
[ "$CODE" = "401" ] || fail "CI result signed with another secret accepted ($CODE)"
ok "result signed with a secret that is not this project's rejected (401)"
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
CLAIMS_BEFORE=$(api GET /v1/projects/hello/events | json 'v.items.filter(e=>e.action==="task.claimed").length')
set +e; "$AF" work hello --once --json >"$WORK/work2.json" 2>"$WORK/work2.err"; RC=$?; set -e
[ $RC -eq 3 ] || { cat "$WORK/work2.err"; fail "worker should exit 3 (nothing started) on a commit the donor never approved, got $RC"; }
grep -q "project moved to .*agentfund approve $BASE/hello" "$WORK/work2.err" || { cat "$WORK/work2.err"; fail "worker did not say to re-approve"; }
[ "$(api GET /v1/projects/hello | json 'v.totals.reported')" = "$TOKENS" ] || fail "tokens were burned on an unapproved commit"
[ "$(api GET /v1/tasks/hello:0002-truncate | json 'v.state')" = "open" ] || fail "task was claimed at an unapproved commit"
[ "$(api GET /v1/projects/hello/events | json 'v.items.filter(e=>e.action==="task.claimed").length')" = "$CLAIMS_BEFORE" ] || fail "a claim was made at an unapproved commit"
"$AF" dry-run hello -n 1 2>&1 | grep -q "project moved to" || fail "dry-run did not say the project moved"
"$AF" status 2>&1 | grep -q "project moved to" || fail "status did not say the project moved"
ok "not claimed (exit 3): task still open, no new task.claimed event, no tokens burned; dry-run and status say to re-approve"
"$AF" approve "$BASE/hello" --yes --no-pager >/dev/null 2>&1
"$AF" work hello --once --json >"$WORK/work3.json" 2>"$WORK/work3.err" || { cat "$WORK/work3.err"; fail "second task after re-approval"; }
[ "$(tail -n 1 "$WORK/work3.json" | json 'v.outcome+" "+v.task+" "+v.report_accepted')" = "completed 0002-truncate true" ] || fail "second task: $(tail -n 1 "$WORK/work3.json")"
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

if [ "$KEEP" = "--serve" ]; then
  printf '\nInstance left running: %s/hello  (dev login: maintainer or donor). Ctrl-C to stop.\n' "$BASE"
  wait "$SERVER_PID"
fi
