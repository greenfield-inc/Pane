# shellcheck shell=bash
# In-sandbox Pane fixtures, driven only through the documented runpane CLI (`rcl/rp` shim).

# fixture_shell_pane <sandbox-id> <name> -> prints {"paneId":..,"panelId":..} of a bash tool panel
fixture_shell_pane() {
  local sid="$1" name="$2"
  sbx "$sid" 300 <<SH
set -e
RP=/home/user/rcl/rp
if [ ! -d /home/user/e2e-repo/.git ]; then
  git init -q -b main /home/user/e2e-repo && cd /home/user/e2e-repo && git -c user.email=e2e@rc-loop -c user.name=e2e commit -q --allow-empty -m init
  \$RP repos add --path /home/user/e2e-repo --name e2e-repo --yes --json >/home/user/rcl/repos-add.json
fi
\$RP panes create --repo e2e-repo --name $name --tool-command bash --title $name-shell --source agent --no-focus --wait-ready --yes --json > /home/user/rcl/pane-$name.json || true
python3 - <<'PY'
import json
d=json.load(open('/home/user/rcl/pane-$name.json'))
it=(d.get('items') or [{}])[0]
pane=it.get('sessionId') or it.get('paneId')
panel=it.get('panelId')
print(json.dumps({"paneId":pane,"panelId":panel}))
PY
SH
}

# rp_in <sandbox-id> <runpane args...> : run the in-sandbox runpane CLI, print its stdout+stderr, keep exit code
rp_in() {
  local sid="$1"; shift
  local q; q=$(printf '%q ' "$@")
  sbx "$sid" 300 <<SH
/home/user/rcl/rp $q
SH
}

# fixture_agent_pane <sandbox-id> <name> <agent> -> {"paneId","panelId"} of an agent pane (claude|codex)
fixture_agent_pane() {
  local sid="$1" name="$2" agent="$3"
  sbx "$sid" 300 <<SH
RP=/home/user/rcl/rp
\$RP panes create --repo e2e-repo --name $name --agent $agent --source agent --no-focus --wait-ready --ready-timeout-ms 90000 --yes --json > /home/user/rcl/pane-$name.json 2>/home/user/rcl/pane-$name.err
python3 -c "import json;d=json.load(open('/home/user/rcl/pane-$name.json'));it=(d.get('items') or [{}])[0];print(json.dumps({'paneId':it.get('sessionId'),'panelId':it.get('panelId'),'ok':it.get('ok'),'blocked':(it.get('readiness') or {}).get('blocked')}))"
SH
}

# submit_invoke <pairing> <panel> <text> [idempotency-key] -> prints the /invoke JSON; exit 0 on HTTP 200
submit_invoke() {
  local req; req=$(python3 -c 'import json,sys;r={"panelId":sys.argv[1],"input":sys.argv[2]};
if len(sys.argv)>3 and sys.argv[3]: r["idempotencyKey"]=sys.argv[3]
print(json.dumps([r]))' "$2" "$3" "${4:-}")
  cl remote invoke "$1" runpane:panels:submit "$req" "${@:5}"
}

# wait_screen <pairing> <panel> <needle> [timeout-s] : poll panels:screen over /invoke until needle shows
wait_screen() {
  local end=$(( $(date +%s) + ${4:-30} ))
  while [ "$(date +%s)" -lt "$end" ]; do
    cl remote invoke "$1" runpane:panels:screen "[{\"panelId\":\"$2\",\"limit\":80}]" | grep -qF -- "$3" && return 0
    sleep 1
  done
  return 1
}

# wait_last_message <pairing> <panel> <needle> [timeout-s] : poll the agent's last reply until it contains needle
wait_last_message() {
  local end=$(( $(date +%s) + ${4:-120} )) out
  while [ "$(date +%s)" -lt "$end" ]; do
    out=$(cl remote invoke "$1" runpane:panels:last-message "[{\"panelId\":\"$2\",\"limit\":4000}]")
    grep -qF -- "$3" <<<"$out" && { printf '%s\n' "$out"; return 0; }
    sleep 3
  done
  printf '%s\n' "$out"; return 1
}
