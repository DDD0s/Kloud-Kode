#!/usr/bin/env bash
# Runs ON the brain host via deploy.sh. Arg 1: agentvr-api directory.
# Expects every file in FILES to have been uploaded as "<file>.new".
set -euo pipefail
DIR="$1"
cd "$DIR"
# The brain may keep node outside PATH for non-interactive shells.
if [[ -f ./env ]]; then set -a; source ./env; set +a; fi
NODE="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE" ]] || { echo "node not found; set NODE_BIN in agentvr-api/env" >&2; exit 1; }
PORT="${AGENTVR_API_PORT:-18888}"
KEY=$(awk -F': ' '/^api-key:/{print $2; exit}' KEYS.txt)
ts=$(date +%Y%m%d-%H%M%S)
FILES="server.mjs package.json README.md start.sh stop.sh ../agentvr/tunnel-up.sh"

for f in $FILES; do
  sed -i 's/\r$//' "$f.new"
done
chk=$(mktemp --suffix=.mjs); cp server.mjs.new "$chk"; "$NODE" --check "$chk"; rm -f "$chk"
bash -n start.sh.new
bash -n stop.sh.new
bash -n ../agentvr/tunnel-up.sh.new

# Do not cut off a turn that is running right now (wait up to 5 minutes).
for _ in $(seq 1 60); do
  busy=$(curl -sf --max-time 3 -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/healthz" \
    | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).in_flight||0)}catch{console.log(0)}})' \
    || echo 0)
  [[ "$busy" == "0" ]] && break
  echo "waiting: $busy turn(s) in flight"
  sleep 5
done

for f in $FILES; do
  if [[ -f "$f" ]]; then cp -p "$f" "$f.bak-$ts"; fi
  mv "$f.new" "$f"
done
chmod 755 start.sh stop.sh ../agentvr/tunnel-up.sh
echo "backup suffix: .bak-$ts"

./stop.sh || true
./start.sh </dev/null
sleep 1.5

if curl -sf --max-time 5 -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/healthz" | grep -q '"builtin_tools"'; then
  echo "deploy OK"
  curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/healthz"
  echo
else
  echo "deploy FAILED health check, rolling back" >&2
  tail -n 30 logs/agentvr-api.log >&2 || true
  for f in $FILES; do
    if [[ -f "$f.bak-$ts" ]]; then cp -p "$f.bak-$ts" "$f"; fi
  done
  ./stop.sh || true
  ./start.sh </dev/null
  exit 1
fi
