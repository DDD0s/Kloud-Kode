#!/usr/bin/env bash
# Deploy to the brain host from this repo.
#
#   bash deploy/deploy.sh            # test, upload, restart, verify, auto-rollback on failure
#   bash deploy/deploy.sh rollback   # restore the most recent backup
#
# Runs from Windows Git Bash or Linux. Needs ssh to the brain to work.
# Set AGENTVR_DEPLOY_HOST / AGENTVR_REMOTE_DIR, or put them in deploy/target.
set -euo pipefail

# Your brain host and where the checkout lives on it. deploy/target is git-ignored.
if [[ -f "$(dirname "$0")/target" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$(dirname "$0")/target"
  set +a
fi
HOST="${AGENTVR_DEPLOY_HOST:?set AGENTVR_DEPLOY_HOST, or create deploy/target}"
REMOTE_DIR="${AGENTVR_REMOTE_DIR:-$HOME/agentvr-api}"
REMOTE_TUNNEL_DIR="$(dirname "$REMOTE_DIR")/agentvr"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)
SCP=(scp -q -o BatchMode=yes)

if [[ "${1:-}" == "rollback" ]]; then
  "${SSH[@]}" "$HOST" "bash -s" -- "$REMOTE_DIR" < "$ROOT/deploy/remote-rollback.sh"
  exit $?
fi

echo "== local tests"
(cd "$ROOT/agentvr-api" && node --test test/server.test.mjs)

echo "== upload to $HOST (staged as *.new)"
for f in server.mjs package.json README.md start.sh stop.sh; do
  "${SCP[@]}" "$ROOT/agentvr-api/$f" "$HOST:$REMOTE_DIR/$f.new"
done
"${SCP[@]}" "$ROOT/agentvr/tunnel-up.sh" "$HOST:$REMOTE_TUNNEL_DIR/tunnel-up.sh.new"

echo "== swap, restart, verify"
"${SSH[@]}" "$HOST" "bash -s" -- "$REMOTE_DIR" < "$ROOT/deploy/remote-swap.sh"
