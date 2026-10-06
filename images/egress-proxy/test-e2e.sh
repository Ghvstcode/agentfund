#!/usr/bin/env bash
# End-to-end proof with real Docker networking.
#
#   sandbox (curl) ──[ --internal network: no route out ]── egress-proxy ──[ bridge ]── internet
#
# Shows that from a container attached ONLY to the internal network:
#   1. HTTPS to an allowlisted host through the proxy works,
#   2. HTTPS to a non-allowlisted host through the proxy is refused (403),
#   3. going direct (no proxy) fails — there is no route out,
#   4. plain-HTTP proxying is refused (405),
# plus a few extra abuse cases, the image HEALTHCHECK, and graceful stop.
#
# Usage: ./test-e2e.sh            (builds agentfund/egress-proxy:dev first)
#        SKIP_BUILD=1 ./test-e2e.sh
#        IMAGE=some/other:tag ./test-e2e.sh
#
# Needs: docker, and internet access from the Docker host.

set -uo pipefail

IMAGE="${IMAGE:-agentfund/egress-proxy:dev}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:latest}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ID="egress-e2e-$$-${RANDOM}"
NET="${ID}-internal"
PROXY="${ID}-proxy"

failures=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

cleanup() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Run curl in a throwaway container attached ONLY to the internal network.
# Prints curl's -w output on one line and appends its exit code.
sandbox_curl() {
  local out rc
  out="$(docker run --rm --network "$NET" "$CURL_IMAGE" \
    -sS -o /dev/null --max-time 20 \
    -w 'http_code=%{http_code} proxy_connect_code=%{http_connect}' "$@" 2>&1)"
  rc=$?
  printf '%s curl_exit=%s' "$(printf '%s' "$out" | tr '\n' ' ')" "$rc"
}

expect() { # description, actual output, substring that must be present
  printf '        %s\n' "$2"
  if [[ "$2" == *"$3"* ]]; then pass "$1"; else fail "$1 (wanted: $3)"; fi
}

if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "== build $IMAGE"
  docker build -q -t "$IMAGE" "$HERE" || { echo "build failed"; exit 1; }
fi
printf '== image: %s  size: %s\n' "$IMAGE" \
  "$(docker image inspect -f '{{.Size}}' "$IMAGE" | awk '{printf "%.2f MB", $1/1000000}')"

echo "== setup"
docker network create --internal "$NET" >/dev/null || exit 1
echo "   internal network: $NET"
# Proxy: attached to the default bridge (way out) and to the internal network
# (where the sandbox reaches it as \"proxy\").
docker create --name "$PROXY" --network bridge \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --health-interval 2s --health-start-period 1s \
  -e ALLOW_HOSTS=api.anthropic.com,github.com \
  "$IMAGE" >/dev/null || exit 1
docker network connect --alias proxy "$NET" "$PROXY" || exit 1
docker start "$PROXY" >/dev/null || exit 1
echo "   proxy container:  $PROXY (bridge + $NET, alias 'proxy')"

echo "== image HEALTHCHECK (/egress-proxy --healthcheck)"
health=starting
for _ in $(seq 1 30); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$PROXY" 2>/dev/null || echo gone)"
  [[ "$health" == healthy ]] && break
  sleep 1
done
expect "container reports healthy" "health=$health" "health=healthy"

echo "== 1. allowlisted host through the proxy: https://github.com"
expect "tunnel established, HTTP status from github.com" \
  "$(sandbox_curl -x http://proxy:3128 https://github.com)" \
  "http_code=200 proxy_connect_code=200 curl_exit=0"

echo "== 1b. second allowlisted host: https://api.anthropic.com (any HTTP status = tunnel works)"
expect "tunnel established to api.anthropic.com" \
  "$(sandbox_curl -x http://proxy:3128 https://api.anthropic.com)" \
  "proxy_connect_code=200 curl_exit=0"

echo "== 2. non-allowlisted host through the proxy: https://example.com"
expect "CONNECT refused with 403" \
  "$(sandbox_curl -x http://proxy:3128 https://example.com)" \
  "proxy_connect_code=403"

echo "== 3. direct, no proxy: https://github.com (must fail: no route out)"
out="$(sandbox_curl --max-time 8 https://github.com)"
printf '        %s\n' "$out"
if [[ "$out" == *"curl_exit=0"* ]]; then fail "direct egress must not work"; else pass "direct egress by name fails"; fi
out="$(sandbox_curl --max-time 8 https://1.1.1.1)"
printf '        %s\n' "$out"
if [[ "$out" == *"curl_exit=0"* ]]; then fail "direct egress by IP must not work"; else pass "direct egress by IP fails"; fi

echo "== 4. plain HTTP through the proxy: http://example.com"
expect "plain-HTTP proxying refused with 405" \
  "$(sandbox_curl -x http://proxy:3128 http://example.com)" \
  "http_code=405"

echo "== extras"
expect "IP-literal CONNECT refused (https://1.1.1.1)" \
  "$(sandbox_curl -x http://proxy:3128 https://1.1.1.1)" \
  "proxy_connect_code=403"
expect "metadata address refused (169.254.169.254:80)" \
  "$(sandbox_curl -p -x http://proxy:3128 http://169.254.169.254/latest/meta-data/)" \
  "proxy_connect_code=403"
expect "allowlisted host on a non-allowlisted port refused (CONNECT github.com:80)" \
  "$(sandbox_curl -p -x http://proxy:3128 http://github.com)" \
  "proxy_connect_code=403"
expect "non-allowlisted subdomain refused (api.github.com)" \
  "$(sandbox_curl -x http://proxy:3128 https://api.github.com)" \
  "proxy_connect_code=403"
expect "plain HTTP to an allowlisted host still refused (http://github.com)" \
  "$(sandbox_curl -x http://proxy:3128 http://github.com)" \
  "http_code=405"

echo "== graceful stop (SIGTERM)"
docker stop -t 10 "$PROXY" >/dev/null
expect "proxy exits 0 on SIGTERM" \
  "exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$PROXY")" "exit_code=0"

echo "== proxy log (stdout, one JSON object per line)"
docker logs "$PROXY" 2>&1 | sed 's/^/   /'

echo
if [[ "$failures" -eq 0 ]]; then
  echo "E2E RESULT: all checks passed"
else
  echo "E2E RESULT: $failures check(s) FAILED"
fi
exit "$failures"
