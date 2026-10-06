# Shared by scripts/e2e.sh and scripts/demo.sh: stand up a real local instance with a signed
# file:// sample project and a worker whose sandbox image runs the mock agent. POSIX sh; source it.
#
# The caller sets, before calling anything here:
#   ROOT   repository root            WORK   scratch directory (created by the caller)
#   PORT   port for the server        BASE   its public URL, e.g. http://127.0.0.1:18787
#   PG     name for the Postgres container
# and owns cleanup (see lib_stop). Functions set: AF, REPO, REPO_URL, HEAD0, SERVER_PID, MAINT,
# DONOR, AF_KEY, FPR, SECRET.

SERVER_PID=""

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*" >&2; [ -f "$WORK/server.log" ] && tail -n 40 "$WORK/server.log" >&2; exit 1; }

# json EXPR  — evaluate a JS expression over the JSON on stdin, bound to `v`.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=(new Function("v","return "+process.argv[1]))(v);console.log(typeof r==="object"?JSON.stringify(r):r)})' "$1"; }

api()  { # method path [body] [token]
  if [ -n "${3:-}" ]; then
    curl -fsS -X "$1" "$BASE$2" -H 'content-type: application/json' ${4:+-H "authorization: Bearer $4"} -d "$3"
  else
    curl -fsS -X "$1" "$BASE$2" ${4:+-H "authorization: Bearer $4"}
  fi
}

ci_result() { # json body → generic CI webhook, signed with the project's secret ($SECRET)
  sig=$(printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
  curl -fsS -X POST "$BASE/v1/webhooks/ci" -H 'content-type: application/json' \
    -H "X-AgentFund-Signature: sha256=$sig" -d "$1"
}

wait_for() { # description, command...
  desc=$1; shift; i=0
  until "$@" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 120 ] && fail "timed out waiting for $desc"; sleep 0.5; done
}

# lib_need TOOL...  — fail early, naming everything that is missing at once.
lib_need() {
  missing=""
  for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
  [ -z "$missing" ] || { printf 'missing on PATH:%s\n' "$missing" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start it and try again." >&2; exit 1; }
}

# lib_build [SCENARIOS]  — server, web, worker binary, mock-agent sandbox image(s), egress proxy.
# SCENARIOS defaults to every scripted mock behaviour; the demo only needs "happy".
lib_build() {
  (cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null)
  (cd "$ROOT" && pnpm --filter web build >/dev/null && pnpm --filter server build >/dev/null)
  (cd "$ROOT/worker" && make build >/dev/null && make e2e-images ${1:+E2E_SCENARIOS="$1"} >/dev/null)
  docker image inspect agentfund/egress-proxy:dev >/dev/null 2>&1 || docker build -q -t agentfund/egress-proxy:dev "$ROOT/images/egress-proxy" >/dev/null
  AF="$ROOT/worker/bin/agentfund"
}

# lib_sample_project  — copy examples/hello-project to $WORK, re-sign it, commit it.
lib_sample_project() {
  REPO="$WORK/hello-project"
  cp -R "$ROOT/examples/hello-project" "$REPO"
  REPO_URL="file://$REPO"
  cp "$REPO/.example-key/example.key" "$WORK/maintainer.key"; rm -rf "$REPO/.example-key"
  sed -i.bak -e "s|^repo_url:.*|repo_url: $REPO_URL|" -e "s|^ci_provider:.*|ci_provider: generic|" "$REPO/agentfund.yaml" && rm "$REPO/agentfund.yaml.bak"
  "$AF" validate "$REPO/tasks" >/dev/null
  "$AF" sign "$REPO/tasks" --key "$WORK/maintainer.key" >/dev/null
  git -C "$REPO" init -q -b main
  git -C "$REPO" -c user.name=maintainer -c user.email=m@example.test add -A
  git -C "$REPO" -c user.name=maintainer -c user.email=m@example.test commit -qm "chore: signed task set"
  HEAD0=$(git -C "$REPO" rev-parse HEAD)
}

# lib_start_server INSTANCE_NAME  — Postgres in Docker (random loopback port) + the built server.
lib_start_server() {
  docker run -d --rm --name "$PG" -e POSTGRES_PASSWORD=local -e POSTGRES_DB=agentfund -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
  wait_for "postgres" docker exec "$PG" pg_isready -U postgres
  PGPORT=$(docker port "$PG" 5432/tcp | head -n1 | sed 's/.*://')
  (
    cd "$ROOT/server"
    PORT=$PORT BASE_URL=$BASE DATABASE_URL="postgres://postgres:local@127.0.0.1:$PGPORT/agentfund" \
    AUTH_DEV_LOGIN=true ALLOW_FILE_REPOS=true DATA_DIR="$WORK/server-data" \
    INDEX_INTERVAL_SECONDS=2 SWEEP_INTERVAL_SECONDS=2 INSTANCE_NAME="$1" LOG_LEVEL=warn \
    exec node dist/main.js
  ) >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  wait_for "server /healthz" curl -fsS "$BASE/healthz"
}

# lib_accounts_and_project  — dev-login a maintainer and a donor, mint the donor's API key,
# register the sample project as "hello".
lib_accounts_and_project() {
  MAINT=$(api POST /v1/auth/dev '{"handle":"maintainer"}' | json 'v.token')
  DONOR=$(api POST /v1/auth/dev '{"handle":"donor"}' | json 'v.token')
  AF_KEY=$(api POST /v1/me/api-keys '{"label":"local worker"}' "$DONOR" | json 'v.key')
  PREVIEW=$(api POST /v1/projects/preview "{\"repo_url\":\"$REPO_URL\"}" "$MAINT")
  [ "$(echo "$PREVIEW" | json 'v.ok && v.signature_valid && v.manifests.length===3')" = "true" ] || fail "preview: $PREVIEW"
  PROJECT=$(api POST /v1/projects "{\"repo_url\":\"$REPO_URL\",\"slug\":\"hello\"}" "$MAINT")
  [ "$(echo "$PROJECT" | json 'v.pinned_commit')" = "$HEAD0" ] || fail "project not pinned at head"
  FPR=$(echo "$PROJECT" | json 'v.pubkey_fingerprint')
  SECRET=$(api GET /v1/projects/hello/webhook "" "$MAINT" | json 'v.secret')   # per-project webhook secret (maintainer only)
  [ -n "$SECRET" ] || fail "no webhook secret for project hello"
}

# lib_worker_env  — point the worker at throwaway config/data dirs and the mock-agent image,
# allow file:// repos in its policy, and log it in with the donor's API key.
lib_worker_env() {
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
}

lib_stop() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  docker rm -f "$PG" >/dev/null 2>&1 || true
}
