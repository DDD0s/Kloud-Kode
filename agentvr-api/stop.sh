#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDF="$DIR/agentvr-api.pid"
if [[ ! -f "$PIDF" ]]; then
  echo "no pid file"
  exit 0
fi
pid=$(cat "$PIDF" || true)
if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  sleep 0.5
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  echo "stopped pid=$pid"
else
  echo "not running"
fi
rm -f "$PIDF"
