#!/bin/sh
# Re-record the README's two animations from one real session:
#   docs/assets/demo.gif            the terminal (docs/assets/tapes/demo.tape, via vhs)
#   docs/assets/live-{light,dark}.gif   the project page of the same instance, at the same time
#
#   sh scripts/record-demo.sh
#
# Starts `scripts/demo.sh --manual` in /tmp/agentfund-demo (short paths read better on screen),
# records, builds, and tears everything down. No tokens are spent: the sandbox image's `claude`
# is the mock agent. Needs what demo.sh needs, plus vhs, ffmpeg, gifsicle, pngquant, oxipng.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RAW="$ROOT/docs/assets/.raw"
export DEMO_DIR=/tmp/agentfund-demo NO_OPEN=1
for tool in vhs ffmpeg gifsicle; do command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool (brew install vhs ffmpeg gifsicle)" >&2; exit 1; }; done
mkdir -p "$RAW"
cd "$ROOT"

sh scripts/demo.sh --manual >"$RAW/demo.log" 2>&1 &
DEMO_PID=$!
LIVE_PID=""
cleanup() { [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null || true; kill "$DEMO_PID" 2>/dev/null || true; wait "$DEMO_PID" 2>/dev/null || true; sh scripts/demo.sh down >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

printf 'starting the demo instance'
i=0; until [ -f "$DEMO_DIR/env" ]; do
  i=$((i+1)); [ $i -gt 600 ] && { echo; tail -n 20 "$RAW/demo.log"; echo "demo did not come up" >&2; exit 1; }
  kill -0 "$DEMO_PID" 2>/dev/null || { echo; cat "$RAW/demo.log"; exit 1; }
  printf '.'; sleep 1
done
echo " up"

node scripts/readme-live.mjs 75 >"$RAW/live.log" 2>&1 &   # longer than the tape; build-assets.sh trims
LIVE_PID=$!
until grep -q capturing "$RAW/live.log" 2>/dev/null; do sleep 0.5; done
vhs docs/assets/tapes/demo.tape >/dev/null
cp "$DEMO_DIR/tape-start" "$RAW/tape-start"
wait "$LIVE_PID"; LIVE_PID=""

sh scripts/build-assets.sh recording
