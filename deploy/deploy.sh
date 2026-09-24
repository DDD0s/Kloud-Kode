#!/usr/bin/env bash
# Deploy the shared repository's main branch to the brain host.
#
#   bash deploy/deploy.sh            # test locally, then the brain pulls origin/main, restarts, verifies
#   bash deploy/deploy.sh rollback   # the brain goes back to the commit it ran before the last deploy
#
# The brain host pulls from GitHub itself (it needs read access to the repo),
# so what runs there is always a real commit, and a rollback is a git reset.
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
REMOTE_DIR="${AGENTVR_REMOTE_DIR:?set AGENTVR_REMOTE_DIR to the agentvr-api directory of the checkout on the brain}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10)

if [[ "${1:-}" == "rollback" ]]; then
  "${SSH[@]}" "$HOST" "bash -s" -- "$REMOTE_DIR" < "$ROOT/deploy/remote-rollback.sh"
  exit $?
fi

# The brain deploys origin/main, so what you tested here has to be what is there.
cd "$ROOT"
git fetch -q origin
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "local changes are not committed; commit and push them first" >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "local HEAD $(git rev-parse --short HEAD) is not origin/main $(git rev-parse --short origin/main); push or pull first" >&2
  exit 1
fi
echo "== deploying $(git log --oneline -1)"

echo "== local tests"
(cd "$ROOT/agentvr-api" && node --test test/server.test.mjs)

echo "== pull, restart, verify on $HOST"
"${SSH[@]}" "$HOST" "bash -s" -- "$REMOTE_DIR" < "$ROOT/deploy/remote-swap.sh"
