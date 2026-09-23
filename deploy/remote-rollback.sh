#!/usr/bin/env bash
# Runs ON the brain host via `deploy.sh rollback`. Restores the newest *.bak-<timestamp> set.
set -euo pipefail
cd "$1"
latest=$(ls -1 server.mjs.bak-* 2>/dev/null | sort | tail -n 1 || true)
if [[ -z "$latest" ]]; then
  echo "no server.mjs.bak-* backup found" >&2
  exit 1
fi
ts="${latest#server.mjs.bak-}"
for f in server.mjs package.json README.md start.sh stop.sh ../agentvr/tunnel-up.sh; do
  if [[ -f "$f.bak-$ts" ]]; then cp -p "$f.bak-$ts" "$f"; fi
done
./stop.sh || true
./start.sh </dev/null
echo "rolled back to backup $ts"
