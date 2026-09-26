#!/usr/bin/env bash
# Runs ON the brain host via deploy.sh. Arg 1: the komputer-api directory inside the checkout.
# Pulls origin/main, restarts the API, and goes back to the previous commit if it does not come up.
set -euo pipefail
DIR="$1"
cd "$DIR"
REPO="$(git rev-parse --show-toplevel)"
PROJECT="$(cd .. && pwd)"
PREFIX="$(git -C "$PROJECT" rev-parse --show-prefix)"
MCP_REL="${PREFIX}komputer-session/.mcp.json"
API_REL="${PREFIX}komputer-api/server.mjs"
# The brain may keep node outside PATH for non-interactive shells.
if [[ -f ./env ]]; then set -a; source ./env; set +a; fi
NODE="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE" ]] || { echo "node not found; set NODE_BIN in komputer-api/env" >&2; exit 1; }
PORT="${KOMPUTER_API_PORT:-18888}"
if [[ -n "${KOMPUTER_TLS_CERT_FILE:-}" && -z "${KOMPUTER_DEPLOY_HEALTH_URL:-}" ]]; then
  echo "TLS deployments need KOMPUTER_DEPLOY_HEALTH_URL using a certificate-valid HTTPS hostname" >&2
  exit 1
fi
HEALTH="${KOMPUTER_DEPLOY_HEALTH_URL:-http://127.0.0.1:$PORT/healthz}"
KEY=$(awk -F': ' '/^api-key:/{print $2; exit}' KEYS.txt)
# The session's .mcp.json carries this host's real body token; the repo only has a placeholder.
MCP="$PROJECT/komputer-session/.mcp.json"

prev=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" fetch -q origin
next=$(git -C "$REPO" rev-parse origin/main)
echo "running $prev"
echo "target  $next"

# Never switch to a revision that removes the running application's layout.
# The one-time naming migration must be performed while the service is stopped.
for rev in "$prev" "$next"; do
  if ! git -C "$REPO" cat-file -e "$rev:$API_REL" 2>/dev/null \
    || ! git -C "$REPO" cat-file -e "$rev:$MCP_REL" 2>/dev/null; then
    echo "revision $rev is not compatible with the komputer layout; use the migration guide" >&2
    exit 1
  fi
done

# Check the new code before touching anything.
chk=$(mktemp --suffix=.mjs)
git -C "$REPO" show "$next:$API_REL" > "$chk"
"$NODE" --check "$chk"
rm -f "$chk"

# Do not cut off a turn that is running right now (wait up to 5 minutes).
for _ in $(seq 1 60); do
  busy=$(curl -sf --max-time 3 -H "Authorization: Bearer $KEY" "$HEALTH" \
    | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).in_flight||0)}catch{console.log(0)}})' \
    || echo 0)
  [[ "$busy" == "0" ]] && break
  echo "waiting: $busy turn(s) in flight"
  sleep 5
done
if [[ "$busy" != "0" ]]; then
  echo "turns are still running; deployment was not started" >&2
  exit 1
fi

checkout() {
  local rev="$1" keep
  keep=$(mktemp)
  cp -p "$MCP" "$keep"
  git -C "$REPO" update-index --no-skip-worktree "$MCP_REL"
  git -C "$REPO" reset -q --hard "$rev"
  cp -p "$keep" "$MCP"
  rm -f "$keep"
  git -C "$REPO" update-index --skip-worktree "$MCP_REL"
}

restart() {
  ./stop.sh || true
  ./start.sh </dev/null
  sleep 1.5
}

install_deps() {
  if [[ -f ./package-lock.json ]]; then
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  fi
}

healthy() {
  curl -sf --max-time 5 -H "Authorization: Bearer $KEY" "$HEALTH" | grep -q '"builtin_tools"'
}

echo "$prev" > "$PROJECT/.deploy-prev"
checkout "$next"

if install_deps && restart && healthy; then
  echo "deploy OK"
  curl -s -H "Authorization: Bearer $KEY" "$HEALTH"
  echo
else
  echo "deploy FAILED health check, going back to $prev" >&2
  tail -n 30 logs/komputer-api.log >&2 || true
  checkout "$prev"
  install_deps
  restart
  exit 1
fi
