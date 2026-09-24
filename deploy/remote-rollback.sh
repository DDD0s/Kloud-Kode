#!/usr/bin/env bash
# Runs ON the brain host via `deploy.sh rollback`. Arg 1: the agentvr-api directory.
# Returns the checkout to the commit that ran before the most recent deploy.
set -euo pipefail
cd "$1"
REPO="$(git rev-parse --show-toplevel)"
MCP="$REPO/agentvr-session/.mcp.json"
prev=$(cat "$REPO/.deploy-prev" 2>/dev/null || true)
if [[ -z "$prev" ]]; then
  echo "no .deploy-prev recorded; nothing to roll back to" >&2
  exit 1
fi
keep=$(mktemp)
cp -p "$MCP" "$keep"
git -C "$REPO" update-index --no-skip-worktree agentvr-session/.mcp.json
git -C "$REPO" reset -q --hard "$prev"
cp -p "$keep" "$MCP"
rm -f "$keep"
git -C "$REPO" update-index --skip-worktree agentvr-session/.mcp.json
./stop.sh || true
./start.sh </dev/null
echo "rolled back to $(git -C "$REPO" log --oneline -1)"
