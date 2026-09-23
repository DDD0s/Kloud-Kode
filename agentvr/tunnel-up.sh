#!/usr/bin/env bash
# Bring up the port forward from this brain host to the body machine.
#
#   BODY_SSH      where the body is, as ssh sees it   (default: body)
#   LOCAL_PORT    port on this host                   (default: 18787)
#   BODY_PORT     port the body listens on            (default: 8787)
#
# Put them in agentvr-api/env, or export them before calling.
set -uo pipefail
LOCAL_PORT="${LOCAL_PORT:-18787}"
BODY_PORT="${BODY_PORT:-8787}"
BODY_SSH="${BODY_SSH:-body}"

if curl -sf --max-time 2 "http://127.0.0.1:${LOCAL_PORT}/healthz" >/dev/null; then
  echo '{"ok":true}'
  echo "tunnel already up"
  exit 0
fi

# Kill a stale forward for this port. The pattern is matched against each
# process's own command line, never against this script's, so it cannot
# terminate the shell that is running it.
for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    *"-L 127.0.0.1:${LOCAL_PORT}:"*) kill "$pid" 2>/dev/null ;;
  esac
done
sleep 0.3

nohup ssh -n -o BatchMode=yes -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -N \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${BODY_PORT}" "$BODY_SSH" \
  > /tmp/agentvr-tunnel.log 2>&1 &
echo $! > /tmp/agentvr-tunnel.pid
sleep 1
curl -sf --max-time 3 "http://127.0.0.1:${LOCAL_PORT}/healthz"
echo
echo "tunnel pid $(cat /tmp/agentvr-tunnel.pid)"
