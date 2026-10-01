#!/bin/bash
# Runs IN a Session: restarts the Pane daemon and times how long until each published port answers
# again on its own URL (from inside the tailnet name). With --drop, first removes the given Serve
# entries (as if a boot lost them), so the daemon's boot reconcile must re-apply them.
# usage: daemon-restart.sh [--drop] <url>...     (urls = the ports' https URLs)
set -uo pipefail
DROP=0; [ "${1:-}" = --drop ] && { DROP=1; shift; }
unit=$(systemctl --user list-unit-files --no-legend 2>/dev/null | awk '/pane.*daemon.*\.service/{print $1; exit}')
scope=--user
if [ -z "$unit" ]; then unit=$(systemctl list-unit-files --no-legend | awk '/pane.*daemon.*\.service/{print $1; exit}'); scope=--system; fi
echo "unit: $unit ($scope) pid before: $(systemctl $scope show -p MainPID --value "$unit")"
if [ $DROP = 1 ]; then
  for u in "$@"; do
    p=$(echo "$u" | sed -E 's#^[a-z]+://[^:/]+:([0-9]+).*#\1#')
    sudo -n tailscale serve --https="$p" off 2>&1 || sudo -n tailscale serve --http="$p" off 2>&1
    echo "dropped Serve :$p"
  done
  sudo -n tailscale serve status 2>&1 | sed 's/^/  serve> /'
fi
t0=$(date +%s.%N)
if [ "$scope" = --user ]; then systemctl --user restart "$unit"; else sudo -n systemctl restart "$unit"; fi
echo "restarted at $(date -u +%T.%3N)Z pid after: $(systemctl $scope show -p MainPID --value "$unit")"
for u in "$@"; do
  for i in $(seq 1 240); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$u" 2>/dev/null)
    [ "$code" = 200 ] && break
    sleep 0.5
  done
  printf '%s -> %s after %.1f s\n' "$u" "$code" "$(echo "$(date +%s.%N) - $t0" | bc)"
done
sudo -n tailscale serve status 2>&1 | sed 's/^/  serve> /'
grep -h "ports:" "$HOME"/.pane_remote/logs/pane-*.log 2>/dev/null | tail -8
