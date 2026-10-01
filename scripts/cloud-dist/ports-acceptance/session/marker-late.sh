#!/bin/bash
# Runs IN a Session: reproduces a new Session's order (daemon starts, the bootstrap writes
# /etc/rp-cloud/serve.json later) on an existing one, to prove the daemon picks the marker up
# without a restart. Optionally installs a test .deb first.
# usage: marker-late.sh [deb url]
set -uo pipefail
RP="$HOME/.pane_remote/bin/runpane"
ts() { date -u +%T.%3N; }
rp() { env -u PANE_SESSION_ID "$RP" "$@"; }
pid() { systemctl --user show -p MainPID --value pane-remote-daemon.service; }
if [ -n "${1:-}" ]; then
  cd /tmp && curl -fsSL -o pa.deb "$1" && sudo -n apt-get install -y -q ./pa.deb > /tmp/pa-apt.log 2>&1; echo "$(ts) apt exit=$?"; rm -f /tmp/pa.deb
fi
echo "$(ts) pane $(dpkg-query -W -f='${Version}' pane)"
marker=$(sudo -n cat /etc/rp-cloud/serve.json)
echo "$(ts) marker: $marker"
# A pristine Session: no ports state, no port Serve entries, no notes blocks.
for p in $(sudo -n tailscale serve status --json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(" ".join(k for k,v in d.get("TCP",{}).items() if v.get("HTTPS") or v.get("HTTP")))'); do sudo -n tailscale serve --https="$p" off > /dev/null 2>&1; done
rm -f "$HOME/.runpane-cloud/ports.json"
for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"; do [ -f "$f" ] && sed -i '/runpane-cloud-ports:start/,/runpane-cloud-ports:end/d' "$f"; done
sudo -n rm -f /etc/rp-cloud/serve.json
systemctl --user restart pane-remote-daemon.service
for i in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:42137/health > /dev/null 2>&1 && break; sleep 0.5; done
P0=$(pid); sleep 5
echo "$(ts) daemon pid $P0 started WITHOUT the marker; list says:"
rp port list --json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(" available=%s reason=%s ports=%s" % (d["available"], d.get("unavailableReason"), [p["name"] for p in d["ports"]]))'
echo " notes blocks: $(grep -c runpane-cloud-ports:start "$HOME/.claude/CLAUDE.md" 2>/dev/null || true)"
T0=$(date +%s.%N)
echo "$marker" | sudo -n tee /etc/rp-cloud/serve.json > /dev/null
echo "$(ts) marker written back (as the bootstrap's serve guard does)"
for i in $(seq 1 120); do
  n=$(rp port list --json 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print(sum(1 for p in d["ports"] if p["status"]=="serving"))' 2>/dev/null || true)
  [ "${n:-0}" -ge 2 ] && break; sleep 0.5
done
if [ "${n:-0}" -ge 2 ]; then state="manifest ports serving"; else state="manifest ports NOT serving (gave up)"; fi
printf '%s %s %.1f s after the marker appeared; daemon pid %s (was %s)\n' "$(ts)" "$state" "$(echo "$(date +%s.%N) - $T0" | bc)" "$(pid)" "$P0"
rp port list --json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(" available=%s ports=%s" % (d["available"], [(p["name"],p["url"],p["source"],p["status"]) for p in d["ports"]]))'
for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"; do echo " $f ports-block=$(grep -c runpane-cloud-ports:start "$f" 2>/dev/null || true)"; done
grep -h "ports:\|now in a Runpane Cloud Session\|Session notes" "$HOME"/.pane_remote/logs/pane-*.log | tail -6
