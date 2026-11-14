#!/bin/sh
# Federation, end to end, with two real instances and the real worker binary. Spends no tokens.
#
#   HOME instance (the donor's account lives here)      HOST instance (the project lives here)
#   each with its own Postgres in Docker; they reach each other over loopback HTTP.
#
# Proves: peering with a confirmed key → the host's project is listed on home → a federated
# login is refused until the host's admin opts in → `agentfund login <host> --via <home>` →
# approve at the host → a task claimed, reported and CI-confirmed under the home identity →
# home shows the work as "elsewhere" without counting it → pausing the peer cuts the donor off.
#
# With the mock-agent sandbox image present (make -C worker e2e-images) the task is run by
# `agentfund work --once`; otherwise the claim and report are sent with curl using the key the
# federated login stored, which exercises the same server path.
#
# Needs: docker, node 22 + pnpm, go, git, curl, openssl.   Usage: sh scripts/federation-e2e.sh [--keep]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
KEEP=${1:-}
RUN_ID="affed-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/$RUN_ID.XXXXXX")
HOME_PORT=${FED_HOME_PORT:-18801}
HOST_PORT=${FED_HOST_PORT:-18802}
HOME_URL="http://127.0.0.1:$HOME_PORT"
HOST_URL="http://127.0.0.1:$HOST_PORT"
HOME_HOST="127.0.0.1:$HOME_PORT"
HOST_HOST="127.0.0.1:$HOST_PORT"
PIDS=""
BASE=$HOST_URL   # what lib.sh's api()/ci_result() talk to unless told otherwise

. "$ROOT/scripts/lib.sh"

cleanup() {
  code=$?
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
  docker rm -f "$RUN_ID-home" "$RUN_ID-host" >/dev/null 2>&1 || true
  if [ "$KEEP" = "--keep" ] || [ $code -ne 0 ]; then
    echo "work dir kept: $WORK"; [ $code -ne 0 ] && tail -n 30 "$WORK"/server-*.log 2>/dev/null || true
  else
    rm -rf "$WORK"
  fi
  exit $code
}
trap cleanup EXIT INT TERM

on() { prev=$BASE; BASE=$1; shift; rc=0; "$@" || rc=$?; BASE=$prev; return $rc; }   # on <base-url> api GET /v1/meta

start() { # name port url instance-name
  docker run -d --rm --name "$RUN_ID-$1" -e POSTGRES_PASSWORD=local -e POSTGRES_DB=agentfund -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
  wait_for "postgres ($1)" docker exec "$RUN_ID-$1" pg_isready -U postgres
  pgport=$(docker port "$RUN_ID-$1" 5432/tcp | head -n1 | sed 's/.*://')
  (
    cd "$ROOT/server"
    PORT=$2 BASE_URL=$3 DATABASE_URL="postgres://postgres:local@127.0.0.1:$pgport/agentfund" \
    AUTH_DEV_LOGIN=true ALLOW_FILE_REPOS=true DATA_DIR="$WORK/data-$1" WEB_DIST="$WORK/no-web" \
    INDEX_INTERVAL_SECONDS=2 SWEEP_INTERVAL_SECONDS=2 FEDERATION_SYNC_INTERVAL_SECONDS=2 \
    INSTANCE_NAME="$4" LOG_LEVEL=warn exec node dist/main.js
  ) >"$WORK/server-$1.log" 2>&1 &
  PIDS="$PIDS $!"
  wait_for "server $1 /healthz" curl -fsS "$3/healthz"
}

peer() { # on-url admin-token peer-url extra-json  → adds the peer after confirming the key it publishes
  preview=$(on "$1" api POST /v1/admin/federation/peers/preview "{\"base_url\":\"$3\"}" "$2")
  key=$(echo "$preview" | json 'v.pubkey')
  on "$1" api POST /v1/admin/federation/peers "{\"base_url\":\"$3\",\"pubkey\":\"$key\"$4}" "$2"
}

say "build"
lib_need docker node pnpm go git curl openssl
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter server build >/dev/null)
(cd "$ROOT/worker" && make build >/dev/null)
AF="$ROOT/worker/bin/agentfund"
ok "server and worker binary"

say "two instances"
start home "$HOME_PORT" "$HOME_URL" "Home Instance"
start host "$HOST_PORT" "$HOST_URL" "Host Instance"
[ "$(on "$HOME_URL" api GET /v1/meta | json 'v.capabilities.federation')" = "true" ] || fail "home does not advertise federation"
HOME_FPR=$(on "$HOME_URL" api GET /v1/meta | json 'v.instance_pubkey')
ok "home $HOME_URL, host $HOST_URL"

say "a signed project on the host"
lib_sample_project
HOST_ADMIN=$(on "$HOST_URL" api POST /v1/auth/dev '{"handle":"host-admin"}' | json 'v.token')
PROJECT=$(on "$HOST_URL" api POST /v1/projects "{\"repo_url\":\"$REPO_URL\",\"slug\":\"hello\"}" "$HOST_ADMIN")
[ "$(echo "$PROJECT" | json 'v.pinned_commit')" = "$HEAD0" ] || fail "project not pinned: $PROJECT"
SECRET=$(on "$HOST_URL" api GET /v1/projects/hello/webhook "" "$HOST_ADMIN" | json 'v.secret')
ok "hello registered on the host at $HEAD0"

say "home peers with host: discovery"
HOME_ADMIN=$(on "$HOME_URL" api POST /v1/auth/dev '{"handle":"home-admin"}' | json 'v.token')
ADDED=$(peer "$HOME_URL" "$HOME_ADMIN" "$HOST_URL" "")
[ "$(echo "$ADDED" | json 'v.status+"/"+v.projects+"/"+v.accepts_us')" = "active/1/false" ] || fail "peer after add: $ADDED"
LISTED=$(on "$HOME_URL" api GET /v1/federation/projects)
[ "$(echo "$LISTED" | json 'v.items.map(p=>p.id+" "+p.accepts_local_identities).join()')" = "$HOST_URL/hello false" ] || fail "federated listing: $LISTED"
[ "$(on "$HOME_URL" api GET /v1/projects | json 'v.items.length')" = "0" ] || fail "a peer's project leaked into home's own list"
ok "home lists $HOST_URL/hello as the host's; home's own project list is still empty"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HOME_URL/v1/admin/federation/peers" -H "authorization: Bearer $HOME_ADMIN" -H 'content-type: application/json' -d "{\"base_url\":\"$HOME_URL\",\"pubkey\":\"$HOME_FPR\"}")
[ "$CODE" = "422" ] || fail "an instance peered with itself ($CODE)"
ok "an instance cannot peer with itself"

say "the donor: an account on home only"
ALICE=$(on "$HOME_URL" api POST /v1/auth/dev '{"handle":"alice"}' | json 'v.token')
ALICE_KEY=$(on "$HOME_URL" api POST /v1/me/api-keys '{"label":"laptop"}' "$ALICE" | json 'v.key')
export AGENTFUND_CONFIG_DIR="$WORK/donor-config" AGENTFUND_DATA_DIR="$WORK/donor-data"
mkdir -p "$AGENTFUND_CONFIG_DIR"
cat >"$AGENTFUND_CONFIG_DIR/config.yaml" <<CFG
global:
  allowed_git_hosts: [github.com, file]
  schedule: []
CFG
printf '%s\n' "$ALICE_KEY" | "$AF" login "$HOME_URL" --key-stdin >/dev/null
ok "alice is logged in to home"

say "federated login is refused until the host's admin opts in"
if "$AF" login "$HOST_URL" --via "$HOME_URL" >"$WORK/via-1.txt" 2>&1; then cat "$WORK/via-1.txt"; fail "host admitted a donor from an instance it never peered with"; fi
grep -q "does not accept identities" "$WORK/via-1.txt" || { cat "$WORK/via-1.txt"; fail "unexpected refusal message"; }
ok "not a peer: refused ($(head -c 90 "$WORK/via-1.txt")…)"
peer "$HOST_URL" "$HOST_ADMIN" "$HOME_URL" "" >/dev/null
if "$AF" login "$HOST_URL" --via "$HOME_URL" >"$WORK/via-2.txt" 2>&1; then fail "host admitted a donor while accept_identities was off"; fi
ok "a peer, but identities not accepted: still refused"
on "$HOST_URL" api PATCH "/v1/admin/federation/peers/$HOME_HOST" '{"accept_identities":true}' "$HOST_ADMIN" >/dev/null

say "agentfund login <host> --via <home>"
"$AF" login "$HOST_URL" --via "$HOME_URL" >"$WORK/via-3.txt" 2>&1 || { cat "$WORK/via-3.txt"; fail "federated login"; }
grep -q "as alice@$HOME_HOST" "$WORK/via-3.txt" || { cat "$WORK/via-3.txt"; fail "login did not report the federated handle"; }
ok "$(cat "$WORK/via-3.txt" | sed "s|; key stored.*||")"
HOST_KEY=$(node -e 'const y=require("fs").readFileSync(process.argv[1],"utf8");const i=y.indexOf(process.argv[2]);const m=/api_key:\s*"?(af_[A-Za-z0-9_-]+)/.exec(y.slice(i));console.log(m?m[1]:"")' "$AGENTFUND_CONFIG_DIR/credentials.yaml" "$HOST_URL")
[ -n "$HOST_KEY" ] || fail "no host key in credentials.yaml"
ME=$(on "$HOST_URL" api GET /v1/me "" "$HOST_KEY")
[ "$(echo "$ME" | json 'v.id+" "+v.handle+" "+v.role')" = "$HOME_URL/u/alice alice@$HOME_HOST donor" ] || fail "identity on the host: $ME"
ok "on the host alice is alice@$HOME_HOST, global id $HOME_URL/u/alice, role donor"
wait_for "home to learn that the host accepts its donors" sh -c "curl -fsS '$HOME_URL/v1/federation/projects' | grep -q '\"accepts_local_identities\":true'"
ok "home now tells its donors the host accepts them"

say "approve at the host, then deliver one task under the home identity"
"$AF" approve "$HOST_URL/hello" --yes --no-pager >"$WORK/approve.txt" 2>&1 || { cat "$WORK/approve.txt"; fail "approve"; }
grep -q "$(echo "$PROJECT" | json 'v.pubkey_fingerprint')" "$WORK/approve.txt" || fail "approve did not show the host's maintainer fingerprint"
ok "approved against the maintainer key pinned at the host"
if docker image inspect agentfund/sandbox-e2e:happy agentfund/egress-proxy:dev >/dev/null 2>&1; then
  export AGENTFUND_SANDBOX_IMAGE=agentfund/sandbox-e2e:happy AGENTFUND_EGRESS_PROXY_IMAGE=agentfund/egress-proxy:dev CLAUDE_CODE_OAUTH_TOKEN="e2e-not-a-real-credential"
  "$AF" work hello --once --json >"$WORK/work.json" 2>"$WORK/work.err" || { cat "$WORK/work.err"; fail "work --once"; }
  RESULT=$(tail -n 1 "$WORK/work.json")
  [ "$(echo "$RESULT" | json 'v.outcome')" = "completed" ] || fail "outcome: $RESULT"
  BRANCH=$(echo "$RESULT" | json 'v.branch'); SHA=$(echo "$RESULT" | json 'v.head_sha'); TOKENS=$(echo "$RESULT" | json 'v.tokens_in+v.tokens_out')
  ok "agentfund work --once completed in the sandbox: $TOKENS tokens, branch $BRANCH"
else
  CLAIM=$(on "$HOST_URL" api POST /v1/tasks/hello:0001-slugify/claim "" "$HOST_KEY")
  CID=$(echo "$CLAIM" | json 'v.claim_id'); SHORT=$(echo "$CID" | cut -c5-12)
  BRANCH="agentfund/0001-slugify-$SHORT"; SHA=$HEAD0; TOKENS=120000
  on "$HOST_URL" api POST "/v1/claims/$CID/report" "{\"status\":\"completed\",\"tokens_in\":100000,\"tokens_out\":20000,\"cost_estimate\":0.5,\"branch\":\"$BRANCH\",\"pr_url\":\"https://example.test/pull/1\",\"head_sha\":\"$SHA\",\"verify_exit_code\":0,\"log_digest\":\"$(printf x | openssl dgst -sha256 | sed 's/^.*= //')\"}" "$HOST_KEY" >/dev/null
  ok "claimed and reported with the federated key (no sandbox image here, so by curl): $TOKENS tokens"
fi
BODY="{\"provider\":\"generic\",\"repo_url\":\"$REPO_URL\",\"branch\":\"$BRANCH\",\"head_sha\":\"$SHA\",\"conclusion\":\"success\"}"
[ "$(on "$HOST_URL" ci_result "$BODY" | json 'v.matched')" = "true" ] || fail "CI result did not match"
D=$(on "$HOST_URL" api GET "/v1/donors/alice@$HOME_HOST")
[ "$(echo "$D" | json 'v.id+" "+v.delivered+" "+v.tasks_delivered')" = "$HOME_URL/u/alice $TOKENS 1" ] || fail "host donor profile: $D"
ok "host ledger: alice@$HOME_HOST delivered $TOKENS after CI"

say "home shows it as work elsewhere, and counts none of it"
elsewhere() { [ "$(curl -fsS "$HOME_URL/v1/donors/alice" | json '(v.elsewhere[0]||{}).delivered')" = "$TOKENS" ]; }
wait_for "home to pull alice's standing from the host" elsewhere
P=$(on "$HOME_URL" api GET /v1/donors/alice)
[ "$(echo "$P" | json 'v.elsewhere[0].instance.base_url+" "+v.elsewhere[0].profile_url')" = "$HOST_URL $HOST_URL/u/alice@$HOME_HOST" ] || fail "elsewhere entry: $P"
[ "$(echo "$P" | json 'v.delivered+" "+v.rank')" = "0 null" ] || fail "a peer's numbers were counted locally: $P"
[ "$(on "$HOME_URL" api GET /v1/stats | json 'v.totals.delivered')" = "0" ] || fail "home totals moved"
ok "alice's home profile lists $TOKENS delivered on the host; local delivered 0, no rank, totals untouched"

say "an assertion is single-use and bound to its audience"
A=$(on "$HOME_URL" api POST /v1/federation/assertions "{\"audience\":\"$HOST_URL\"}" "$ALICE_KEY" | json 'JSON.stringify({assertion:v.assertion})')
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HOST_URL/v1/auth/federated" -H 'content-type: application/json' -d "$A")" = "201" ] || fail "fresh assertion refused"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HOST_URL/v1/auth/federated" -H 'content-type: application/json' -d "$A")" = "401" ] || fail "replayed assertion accepted"
W=$(on "$HOME_URL" api POST /v1/federation/assertions '{"audience":"http://127.0.0.1:1"}' "$ALICE_KEY" | json 'JSON.stringify({assertion:v.assertion})')
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HOST_URL/v1/auth/federated" -H 'content-type: application/json' -d "$W")" = "401" ] || fail "assertion for another audience accepted"
ok "replay 401, wrong audience 401"

say "pausing the peer cuts its donors off"
on "$HOST_URL" api PATCH "/v1/admin/federation/peers/$HOME_HOST" '{"status":"paused"}' "$HOST_ADMIN" >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "$HOST_URL/v1/me" -H "authorization: Bearer $HOST_KEY")" = "401" ] || fail "federated key still works while the peer is paused"
[ "$(on "$HOST_URL" api GET "/v1/donors/alice@$HOME_HOST" | json 'v.delivered')" = "$TOKENS" ] || fail "delivered work disappeared with the pause"
ok "key refused (401); the delivered work stays on the host's ledger"

printf '\n\033[1;32mfederation e2e: all checks passed\033[0m\n'
