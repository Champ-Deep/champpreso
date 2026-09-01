#!/bin/bash
# ChampPreso local service control.
#
# The app runs as a macOS LaunchAgent (com.champions.champpreso) so it survives
# crashes, terminal closes, and reboots. This script is the front door for the
# handful of things you'd otherwise need launchctl incantations for.
#
#   ./scripts/champpreso-service.sh status    what's running, and since when
#   ./scripts/champpreso-service.sh update    git pull + npm install + restart
#   ./scripts/champpreso-service.sh restart   restart without changing code
#   ./scripts/champpreso-service.sh logs      follow the log
#   ./scripts/champpreso-service.sh stop      stop and stay stopped
#   ./scripts/champpreso-service.sh start     load it again
#
# The plist lives at ~/Library/LaunchAgents/com.champions.champpreso.plist and
# points at the MAIN checkout, not a worktree - worktrees get removed, and a
# service pointing at a deleted directory is exactly the "it stopped working"
# failure this setup exists to prevent.

set -euo pipefail

LABEL="com.champions.champpreso"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/champpreso.log"
PORT="${CHAMPPRESO_PORT:-4175}"
URL="http://127.0.0.1:${PORT}"

# Repo root = the directory the plist runs in, so this script works from either
# the main checkout or a worktree without editing anything.
REPO="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" 2>/dev/null || true)"
[ -n "$REPO" ] || REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pid_of() {
  launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | awk '/^[[:space:]]+pid = /{print $3; exit}'
}

wait_for_http() {
  local tries=${1:-90}
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null "$URL" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

cmd_status() {
  local pid
  pid="$(pid_of || true)"
  if [ -z "$pid" ]; then
    echo "service:  NOT RUNNING"
    echo "start it: $0 start"
    exit 1
  fi
  echo "service:  running (pid $pid)"
  echo "repo:     $REPO"
  echo "url:      $URL"
  # ps -o etime gives elapsed time, which answers "has it been restarting?"
  echo "uptime:   $(ps -o etime= -p "$pid" | tr -d ' ')"
  if curl -fsS -o /dev/null "$URL" 2>/dev/null; then
    echo "http:     responding"
    curl -fsS "$URL/api/config" 2>/dev/null \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("stt:      " + str(d.get("transcriptionEngine")))' 2>/dev/null || true
  else
    echo "http:     not responding yet (still warming - the local Moonshine model takes ~25s)"
  fi
}

cmd_restart() {
  echo "restarting..."
  launchctl kickstart -k "${DOMAIN}/${LABEL}"
  wait_for_http 120 && echo "up: $URL" || { echo "did not come up; check: $0 logs"; exit 1; }
}

cmd_update() {
  echo "==> pulling in $REPO"
  git -C "$REPO" pull --ff-only
  echo "==> installing dependencies"
  (cd "$REPO" && npm install --silent)
  cmd_restart
  echo "updated and running"
}

case "${1:-status}" in
  status)  cmd_status ;;
  update)  cmd_update ;;
  restart) cmd_restart ;;
  logs)    tail -f "$LOG" ;;
  stop)    launchctl bootout "${DOMAIN}/${LABEL}" && echo "stopped (stays stopped until: $0 start)" ;;
  start)   launchctl bootstrap "$DOMAIN" "$PLIST" && wait_for_http 120 && echo "up: $URL" ;;
  *)       echo "usage: $0 {status|update|restart|logs|stop|start}"; exit 2 ;;
esac
