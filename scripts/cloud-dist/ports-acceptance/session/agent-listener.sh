#!/bin/bash
# Runs IN a Session: starts a listener the way an agent would (a process under a Pane panel, via
# `runpane agents start --tool-command`), plus a control listener that is NOT under a panel. Then
# waits for the daemon's detection round and prints `runpane port list --json`.
# usage: agent-listener.sh <repo path> <panel port> <control port>
#        agent-listener.sh --stop <pane name> <control port>
set -uo pipefail
RP=$(command -v runpane || true); [ -x "$HOME/.pane_remote/bin/runpane" ] && RP="$HOME/.pane_remote/bin/runpane"
rp() { env -u PANE_SESSION_ID -u PANE_PANEL_ID "$RP" "$@"; }
if [ "${1:-}" = --stop ]; then
  id=$(rp panes list --json | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join(p['id'] for p in d.get('panes',d) if p.get('name')=='$2'))" 2>/dev/null)
  for p in $id; do rp panes archive --pane "$p" --force --remove-worktree --yes --json >/dev/null 2>&1 && echo "archived pane $p"; done
  pkill -f "http.server $3 --bind" && echo "control listener $3 stopped"; exit 0
fi
REPO="$1"; PP="$2"; CP="$3"
echo "### $(date -u +%T)Z agents start (tool command = python3 -m http.server $PP)"
rp agents start --repo "$REPO" --name pa-devserver --tool-command "python3 -m http.server $PP --bind 127.0.0.1" --prompt "serve" --yes --json 2>&1 | head -c 1500; echo
echo "### control listener (not under a panel) on $CP"
setsid nohup python3 -m http.server "$CP" --bind 127.0.0.1 >/dev/null 2>&1 < /dev/null &
for i in $(seq 1 30); do
  sleep 1
  rp port list --json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if any(s['port']==$PP for s in d['suggested']) else 1)" && break
done
echo "### $(date -u +%T)Z after ${i}s: runpane port list --json"
rp port list --json
echo "### ss"; ss -ltnp | grep -E ":($PP|$CP) " | cut -c1-160
