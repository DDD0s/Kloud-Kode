#!/usr/bin/env bash
# Runs ON the brain host via deploy.sh. Arg 1: the agentvr-api directory inside the checkout.
# Pulls origin/main, restarts the API, and goes back to the previous commit if it does not come up.
set -euo pipefail
DIR="$1"
cd "$DIR"
REPO="$(git rev-parse --show-toplevel)"
# The brain may keep node outside PATH for non-interactive shells.
if [[ -f ./env ]]; then set -a; source ./env; set +a; fi
NODE="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE" ]] || { echo "node not found; set NODE_BIN in agentvr-api/env" >&2; exit 1; }
PORT="${AGENTVR_API_PORT:-18888}"
KEY=$(awk -F': ' '/^api-key:/{print $2; exit}' KEYS.txt)
# The session's .mcp.json carries this host's real body token; the repo only has a placeholder.
MCP="$REPO/agentvr-session/.mcp.json"

prev=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" fetch -q origin
next=$(git -C "$REPO" rev-parse origin/main)
echo "running $(git -C "$REPO" log --oneline -1 "$prev")"
echo "target  $(git -C "$REPO" log --oneline -1 "$next")"

# Check the new code before touching anything.
chk=$(mktemp --suffix=.mjs)
git -C "$REPO" show "$next:agentvr-api/server.mjs" > "$chk"
"$NODE" --check "$chk"
rm -f "$chk"

# Do not cut off a turn that is running right now (wait up to 5 minutes).
for _ in $(seq 1 60); do
  busy=$(curl -sf --max-time 3 -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/healthz" \
    | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).in_flight||0)}catch{console.log(0)}})' \
    || echo 0)
  [[ "$busy" == "0" ]] && break
  echo "waiting: $busy turn(s) in flight"
  sleep 5
done

checkout() {
  local rev="$1" keep
  keep=$(mktemp)
  cp -p "$MCP" "$keep"
  git -C "$REPO" update-index --no-skip-worktree agentvr-session/.mcp.json
  git -C "$REPO" reset -q --hard "$rev"
  cp -p "$keep" "$MCP"
  rm -f "$keep"
  git -C "$REPO" update-index --skip-worktree agentvr-session/.mcp.json
}

restart() {
  ./stop.sh || true
  ./start.sh </dev/null
  sleep 1.5
}

healthy() {
  curl -sf --max-time 5 -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/healthz" | grep -q '"builtin_tools"'
}

echo "$prev" > "$REPO/.deploy-prev"
checkout "$next"
restart

if healthy; then
  echo "deploy OK"
  curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/healthz"
  echo
else
  echo "deploy FAILED health check, going back to $(git -C "$REPO" log --oneline -1 "$prev")" >&2
  tail -n 30 logs/agentvr-api.log >&2 || true
  checkout "$prev"
  restart
  exit 1
fi
