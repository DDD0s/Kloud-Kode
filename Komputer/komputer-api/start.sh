#!/usr/bin/env bash
# Start the Kloud Kode API on the brain host. Paths come from where this script
# lives, so the checkout can sit anywhere.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
BIN="$DIR/server.mjs"
PIDF="$DIR/komputer-api.pid"
LOG="$DIR/logs/komputer-api.log"

# Optional per-host settings: proxy, listen address, body name, node path.
# Copy env.example to env and edit it; it is git-ignored.
if [[ -f "$DIR/env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$DIR/env"
  set +a
fi

NODE="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
  echo "ERROR: node not found. Install Node 20+ or set NODE_BIN in $DIR/env" >&2
  exit 1
fi
mkdir -p "$DIR/logs"

export KOMPUTER_API_HOST="${KOMPUTER_API_HOST:-127.0.0.1}"
export KOMPUTER_API_PORT="${KOMPUTER_API_PORT:-18888}"
export KOMPUTER_MAX_SESSIONS="${KOMPUTER_MAX_SESSIONS:-0}"
export KOMPUTER_MAX_IN_FLIGHT="${KOMPUTER_MAX_IN_FLIGHT:-4}"
export KOMPUTER_IDLE_TIMEOUT_MS="${KOMPUTER_IDLE_TIMEOUT_MS:-2700000}"

if [[ -f "$PIDF" ]]; then
  old=$(cat "$PIDF" || true)
  if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
    echo "already running pid=$old"
    exit 0
  fi
fi

# Best-effort tunnel so the first request is faster.
TUNNEL="${KOMPUTER_TUNNEL_UP:-$REPO/komputer/tunnel-up.sh}"
if [[ -x "$TUNNEL" ]]; then
  "$TUNNEL" </dev/null >/dev/null 2>&1 || true
fi

nohup "$NODE" "$BIN" </dev/null >>"$LOG" 2>&1 &
echo $! >"$PIDF"
sleep 0.4
if ! kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  echo "ERROR: failed to start — see $LOG" >&2
  exit 1
fi
echo "started pid=$(cat "$PIDF") http://${KOMPUTER_API_HOST}:${KOMPUTER_API_PORT} max_sessions=${KOMPUTER_MAX_SESSIONS} max_in_flight=${KOMPUTER_MAX_IN_FLIGHT}"
