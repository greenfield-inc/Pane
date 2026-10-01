#!/usr/bin/env bash
# Combined M1 + M2 + M3 gate for an integration head, built to spend as few boat starts as possible (~5):
#   X = a cloud Session made by `runpane cloud new` (M1). It also carries the M2 panels (shell + Claude) and is
#       peer B for M3. Its stop/wake cycles are M1's cycles, M2's power-off test and M3's "records survive".
#   A = a second sandbox provisioned by hand (fork .deb), the M3 peer.
# Checks keep the same names as the single-milestone gates (M1-cli/*, M2-resume/*, M3-peers/*) so the matrix
# shows one row per check across both kinds of run.
# Env: E2E_RUNPANE_TGZ_URL (CLI under test), E2E_DAEMON_DEB_URL (daemon under test), E2E_GOLDEN (optional),
#      E2E_CYCLES (3), E2E_CLAUDE=0|1, E2E_TARGET
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/cli.sh"; . "$E2E_LIB/provision.sh"; . "$E2E_LIB/fixtures.sh"; . "$E2E_LIB/claude.sh"
e2e_init INTEGRATION
wait_start_budget $(( 2 + ${E2E_CYCLES:-3} ))
CYCLES="${E2E_CYCLES:-3}"; REPO="${E2E_REPO:-https://github.com/octocat/Hello-World.git}"
g() { E2E_GATE="$1" rec "${@:2}"; }   # record under a milestone's gate name
cli_resolve || { g M1-cli cli BLOCKED "runpane CLI under test not installable"; exit 1; }

# ================================================================ M1: setup + new
GOLDEN="${E2E_GOLDEN:-}"; DEB="${E2E_DAEMON_DEB_URL:-}"
flags=(); if [ -n "$GOLDEN" ]; then flags+=(--golden "$GOLDEN"); else flags+=(--no-golden); [ -n "$DEB" ] && flags+=(--pane-deb-url "$DEB"); fi   # golden: preinstalled daemon
out=$(cloud_setup_from_loop_secrets "${flags[@]}" 2>&1); rc=$?; printf '%s\n' "$out" | ev setup.json >/dev/null
perm=$(stat -c '%a' "$RUNPANE_CLOUD_DIR"); loose=$(find "$RUNPANE_CLOUD_DIR" -type f -perm /077 | wc -l)
[ $rc = 0 ] && [ "$perm" = 700 ] && [ "$loose" = 0 ] && g M1-cli setup PASS "cloud setup ok; dir 0700; daemon=$([ -n "$GOLDEN" ] && echo "preinstalled in $GOLDEN" || echo "${DEB##*/}")" "$E2E_RUN_DIR/setup.json" \
  || { g M1-cli setup FAIL "rc=$rc dir=$perm loose=$loose" "$E2E_RUN_DIR/setup.json"; exit 1; }
t0=$(ms_now)
rpc cloud new --label "e2e-int-$(date -u +%H%M%S)" --repo "$REPO" --size "${E2E_SIZE:-default}" --yes --json > "$E2E_RUN_DIR/new.json" 2> "$E2E_RUN_DIR/new.stderr"; rc=$?
new_s=$(secs_since "$t0")
rec_file=$(ls -t "$RUNPANE_CLOUD_DIR"/hosts/*.json 2>/dev/null | head -1)
[ -n "$rec_file" ] || { g M1-cli new FAIL "rc=$rc; no host record after ${new_s}s: $(tail -c 300 "$E2E_RUN_DIR/new.stderr")" "$E2E_RUN_DIR/new.stderr"; exit 1; }
HOST=$(jget 'd["profile"]["cloud"]["hostname"]' < "$rec_file"); X_ID=$(jget 'd["profile"]["cloud"]["sandboxId"]' < "$rec_file")
NODE=$(jget 'd["profile"]["cloud"]["nodeId"]' < "$rec_file"); PAIR=$(jget 'd["meta"].get("pairingPath") or ""' < "$rec_file")
register_resource sandbox "$X_ID" "$HOST"; [ -n "$NODE" ] && register_resource tsnode "$NODE" "$HOST"
[ -f "$HOME/rc-loop/sandboxes.txt" ] && echo "$X_ID $HOST e2e-gates(cli)" >> "$HOME/rc-loop/sandboxes.txt"
[ $rc = 0 ] && g M1-cli new PASS "cloud new -> $HOST ($X_ID) in ${new_s}s" "$E2E_RUN_DIR/new.json" "seconds=$new_s" \
  || { g M1-cli new FAIL "rc=$rc after ${new_s}s: $(tail -c 300 "$E2E_RUN_DIR/new.stderr")" "$E2E_RUN_DIR/new.stderr"; exit 1; }

sb=$(cl boat get "$X_ID"); printf '%s\n' "$sb" | ev sandbox.json >/dev/null
[ "$(jget 'd.get("name")' <<<"$sb")" = "$HOST" ] && [[ "$(jget 'd.get("state")' <<<"$sb")" =~ ^(idle|ready|running)$ ]] \
  && g M1-cli sandbox-exists PASS "boat: $X_ID name=$HOST" "$E2E_RUN_DIR/sandbox.json" || g M1-cli sandbox-exists FAIL "boat: $(head -c 200 <<<"$sb")"
dev=$(cl ts find "$HOST"); printf '%s\n' "$dev" | ev tailnet-device.json >/dev/null
runssh=$(sbx "$X_ID" 60 <<<'tailscale debug prefs 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get(\"RunSSH\"))"')
[ "$(jget 'len(d)' <<<"$dev")" = 1 ] && [ "$(jget 'd[0]["tags"]' <<<"$dev")" = '["tag:rp-session"]' ] && [ "$(jget 'd[0]["nodeId"]' <<<"$dev")" = "$NODE" ] && [ "$runssh" = False ] \
  && g M1-cli tailnet PASS "one device $NODE, tag:rp-session, RunSSH=False" "$E2E_RUN_DIR/tailnet-device.json" \
  || g M1-cli tailnet FAIL "devices=$(jget 'len(d)' <<<"$dev") tags=$(jget 'd[0]["tags"] if d else None' <<<"$dev") RunSSH=$runssh" "$E2E_RUN_DIR/tailnet-device.json"
pm=$(cl remote pairing-mode "$PAIR"); printf '%s\n' "$pm" | ev pairing.json >/dev/null
[ "$(jget 'd["mode"]' <<<"$pm")" = 0o600 ] && g M1-cli pairing-file PASS "pairing 0600, baseUrl $(jget 'd["baseUrl"]' <<<"$pm")" "$E2E_RUN_DIR/pairing.json" || g M1-cli pairing-file FAIL "mode $(jget 'd["mode"]' <<<"$pm")"
h=$(cl remote wait-health "$PAIR" --timeout 90); printf '%s\n' "$h" | ev health.json >/dev/null
VERSION=$(jget 'd["body"].get("version") if isinstance(d["body"],dict) else None' <<<"$h")
[ "$(jget 'd["http"]' <<<"$h")" = 200 ] && g M1-cli health PASS "tailnet /health 200 version=$VERSION readiness=$(jget 'd["body"].get("readiness",{}).get("state")' <<<"$h")" "$E2E_RUN_DIR/health.json" \
  || { g M1-cli health FAIL "no /health over the tailnet" "$E2E_RUN_DIR/health.json"; exit 1; }
[ -n "$VERSION" ] && [ "$VERSION" != null ] && g M2-resume health-version PASS "/health version=$VERSION" "$E2E_RUN_DIR/health.json" || g M2-resume health-version FAIL "/health has no version"
[ "$(cl remote invoke "$PAIR" runpane:repos:list '[{}]' | jget 'd["http"]')" = 200 ] && g M1-cli paired-client PASS "paired client /invoke 200" || g M1-cli paired-client FAIL "paired client /invoke failed"
rn=$(cl remote invoke "$PAIR" runpane:repos:list '[{}]' | jget '[r.get("name") for r in (d["body"]["result"].get("repositories") or d["body"]["result"].get("repos") or [])]' 2>/dev/null)
want=$(basename "${REPO%.git}")
grep -q "\"$want\"" <<<"$rn" && g M1-cli repo-registered PASS "cloud new --repo registered '$want' with the cloud daemon (repos: $rn)" \
  || g M1-cli repo-registered FAIL "cloud new --repo cloned but did not register '$want' with the cloud daemon (repos: $rn)"
desk="$RUNPANE_CLOUD_DESKTOP_DIR/config.json"
python3 - "$desk" "$HOST" <<'PY' && g M1-cli desktop-profile PASS "desktop profile store has the cloud profile for $HOST" || g M1-cli desktop-profile FAIL "no cloud profile for $HOST in $desk"
import json,sys
d=json.load(open(sys.argv[1])); ps=(((d.get('remoteDaemon') or {}).get('client') or {}).get('profiles') or [])
sys.exit(0 if [p for p in ps if (p.get('cloud') or {}).get('hostname')==sys.argv[2] and p.get('token')] else 1)
PY
creds=$(sbx "$X_ID" 60 <<'SH'
for p in ~/.claude/.credentials.json ~/.config/gh/hosts.yml ~/.git-credentials ~/.npmrc ~/.docker/config.json ~/.ssh/id_rsa ~/.ssh/id_ed25519; do [ -e "$p" ] && echo "$p"; done; true
SH
)
[ -z "$creds" ] && g M1-cli no-credentials PASS "no strip-list credential files in the new sandbox" || g M1-cli no-credentials FAIL "present: $creds"
[ "$(rpc cloud status "$HOST" --json 2>/dev/null | jget 'd.get("status")')" = awake ] && g M1-cli status-awake PASS "cloud status: awake" || g M1-cli status-awake FAIL "cloud status not awake"

# ================================================================ in-sandbox CLI on X (the build under test)
sbx "$X_ID" 300 <<SH | ev x-cli.txt >/dev/null
$(_rp_shim_script)
mkdir -p /home/user/rcl/runpane && cd /home/user/rcl/runpane && npm init -y >/dev/null && npm i --no-audit --no-fund '$E2E_RUNPANE_TGZ_URL' >/home/user/rcl/runpane-install.log 2>&1; echo "rp: \$(/home/user/rcl/rp version | head -1)"
SH

# ================================================================ M2 fixtures on X
fx=$(fixture_shell_pane "$X_ID" m2shell | tail -1); SHELL_PANEL=$(jget 'd["panelId"]' <<<"$fx")
[ -n "$SHELL_PANEL" ] && [ "$SHELL_PANEL" != None ] || { g M2-resume fixture FAIL "shell pane not created: $fx"; }
CLAUDE_PANEL=""; CLAUDE_PANE=""
if claude_available; then
  sandbox_claude_setup "$X_ID" /home/user/e2e-repo/worktrees/m2claude > "$E2E_RUN_DIR/claude-setup.txt" 2>&1
  cl remote wait-health "$PAIR" --timeout 60 >/dev/null
  fa=$(fixture_agent_pane "$X_ID" m2claude claude | tail -1); printf '%s\n' "$fa" | ev claude-pane.json >/dev/null
  CLAUDE_PANEL=$(jget 'd["panelId"] or ""' <<<"$fa"); CLAUDE_PANE=$(jget 'd.get("paneId") or ""' <<<"$fa")
fi
WORD=$(python3 -c 'import random,string;print("".join(random.choice(string.ascii_uppercase) for _ in range(8)))'); LOW=$(tr '[:upper:]' '[:lower:]' <<<"$WORD")
if [ -n "$CLAUDE_PANEL" ]; then
  submit_invoke "$PAIR" "$CLAUDE_PANEL" "Remember this codeword for later: $WORD. Reply with only the word OK." | ev claude-pre-submit.json >/dev/null
  wait_last_message "$PAIR" "$CLAUDE_PANEL" OK 120 | ev claude-pre-reply.json >/dev/null && g M2-resume claude-before PASS "Claude panel answered before any kill" "$E2E_RUN_DIR/claude-pre-reply.json" \
    || { g M2-resume claude-before FAIL "Claude did not answer" "$E2E_RUN_DIR/claude-pre-reply.json"; CLAUDE_PANEL=""; }
else g M2-resume claude-before SKIP "no Claude token"; fi

after_kill() {  # after_kill <phase> <answer-form-description> <expected>
  local phase="$1" m="e2e-$1-$RANDOM" out
  out=$(submit_invoke "$PAIR" "$SHELL_PANEL" "echo $m"); printf '%s\n' "$out" | ev "$phase-shell-submit.json" >/dev/null
  if [ "$(jget 'd["http"]' <<<"$out")" = 200 ] && wait_screen "$PAIR" "$SHELL_PANEL" "$m" 40; then g M2-resume "$phase.shell-submit" PASS "same shell panel accepted submit and ran it" "$E2E_RUN_DIR/$phase-shell-submit.json"
  else g M2-resume "$phase.shell-submit" FAIL "http=$(jget 'd["http"]' <<<"$out"): $(head -c 200 <<<"$out")" "$E2E_RUN_DIR/$phase-shell-submit.json"; fi
  [ -n "$CLAUDE_PANEL" ] || { g M2-resume "$phase.claude-continues" SKIP "no Claude panel"; return; }
  out=$(submit_invoke "$PAIR" "$CLAUDE_PANEL" "What was the codeword I gave you before? Reply with only the codeword $2, nothing else.")
  printf '%s\n' "$out" | ev "$phase-claude-submit.json" >/dev/null
  if [ "$(jget 'd["http"]' <<<"$out")" = 200 ] && wait_last_message "$PAIR" "$CLAUDE_PANEL" "$3" 180 | ev "$phase-claude-reply.json" >/dev/null; then
    g M2-resume "$phase.claude-continues" PASS "same Claude panel answered '$3' from pre-kill context" "$E2E_RUN_DIR/$phase-claude-reply.json"
  else g M2-resume "$phase.claude-continues" FAIL "no reply containing '$3'" "$E2E_RUN_DIR/$phase-claude-reply.json"; fi
}

# ---- M2 A: plain daemon restart
t0=$(ms_now); sbx "$X_ID" 60 <<<'systemctl --user restart pane-remote-daemon.service' >/dev/null
wh=$(cl remote wait-health "$PAIR" --timeout 120 --require 'h.get("readiness",{}).get("state","ready")!="starting"'); printf '%s\n' "$wh" | ev restart-health.json >/dev/null
[ "$(jget 'd["http"]' <<<"$wh")" = 200 ] && g M2-resume restart.health PASS "/health ready $(secs_since "$t0")s after restart (readiness=$(jget 'd["body"].get("readiness")' <<<"$wh" | head -c 160))" "$E2E_RUN_DIR/restart-health.json" \
  || g M2-resume restart.health FAIL "no ready /health after restart"
after_kill restart "written in lowercase letters" "$LOW"

# ================================================================ M3: X is B; A is the peer
# B's orchestrator must be a real agent: peer submits go only into an agent composer (agentOnly), by design.
sandbox_claude_setup "$X_ID" /home/user > "$E2E_RUN_DIR/b-claude-setup.txt" 2>&1
cl remote wait-health "$PAIR" --timeout 90 >/dev/null
sess=$(sbx "$X_ID" 180 <<'SH'
echo '{"name":"e2e-b","agent":"claude"}' | /home/user/rcl/rp sessions create --from-json - --json > /home/user/rcl/session.json
p=$(python3 -c "import json;print(json.load(open('/home/user/rcl/session.json')).get('panelId',''))")
/home/user/rcl/rp panels wait --panel "$p" --for ready --timeout-ms 120000 --json > /home/user/rcl/orch-wait.json 2>&1
cat /home/user/rcl/session.json
SH
); printf '%s\n' "$sess" | ev b-session.json >/dev/null
B_SESSION=$(jget 'd["session"].get("id")' <<<"$sess" 2>/dev/null); ORCH=$(jget 'd.get("panelId")' <<<"$sess" 2>/dev/null)
X_HOST=$HOST; X_PAIR=$PAIR
provision_manual m3a small || { g M3-peers provision FAIL "peer sandbox A not provisioned"; }
A_ID=$SB_ID; A_HOST=$SB_HOST
MINT_SB=$X_ID
mint() {  # mint <label> [session] : peers mint --name (code captured into a 0600 file, never printed), then allow
  local sb="$MINT_SB" allow=""
  [ -n "${2:-}" ] && allow="/home/user/rcl/rp peers allow --peer '$1' --session '$2' --yes --json"
  sbx "$sb" 90 <<SH
umask 077
/home/user/rcl/rp peers mint --name '$1' --yes --json > /home/user/rcl/peer-$1.json 2>/home/user/rcl/peer-$1.err; rc=\$?
python3 - /home/user/rcl/peer-$1.json /home/user/rcl/peer-$1.code <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(json.dumps({"ok": False, "error": "unparsable mint output"})); sys.exit()
code = (d.get("data") or {}).get("connectionCode") or d.get("connectionCode") or ""
open(sys.argv[2], "w").write(code)
peer = (d.get("data") or {}).get("peer") or d.get("peer") or {}
print(json.dumps({"ok": d.get("ok"), "hasCode": code.startswith("pane-remote://"), "peer": {k: peer.get(k) for k in ("id", "label", "scope")}}))
PY
shred -u /home/user/rcl/peer-$1.json; echo "mint rc=\$rc \$(head -c 300 /home/user/rcl/peer-$1.err)"
$allow
SH
}
mint "$A_HOST" "$B_SESSION" | ev mint-a.json >/dev/null; mint rp-loop-e2e-c | ev mint-c.json >/dev/null
PA="$E2E_SECRETS/peer-a.code"; PC="$E2E_SECRETS/peer-c.code"
if cl boat fetch "$X_ID" "/home/user/rcl/peer-$A_HOST.code" "$PA" && cl boat fetch "$X_ID" /home/user/rcl/peer-rp-loop-e2e-c.code "$PC"; then
  M3_OK=1; g M3-peers mint PASS "B minted peers A (allowlisted to $B_SESSION) and C (none)" "$E2E_RUN_DIR/mint-a.json"
  grep -q 'pane-remote://' "$E2E_RUN_DIR/mint-a.json" && g M3-peers mint-no-leak FAIL "code reached evidence" || g M3-peers mint-no-leak PASS "code captured into a 0600 file in the sandbox; not in evidence"
else M3_OK=0; g M3-peers mint FAIL "no peer code files" "$E2E_RUN_DIR/mint-a.json"; fi
if [ "$M3_OK" = 1 ]; then
tokfile() { (umask 077; python3 -c 'import sys;sys.path.insert(0,sys.argv[2]);import cloudlab;print(cloudlab.read_pairing(sys.argv[1])["token"])' "$1" "$E2E_LIB" > "$1.tok"); echo "$1.tok"; }
PAT=$(tokfile "$PA"); PCT=$(tokfile "$PC")
cl boat put "$A_ID" "$PA" rcl/peer-b.code >/dev/null
sbx "$A_ID" 60 <<SH >/dev/null
umask 077; mkdir -p ~/.config/runpane-cloud
python3 - <<'PY'
import base64, json, os, re, datetime
code = open('/home/user/rcl/peer-b.code').read()
enc = re.search(r'pane-remote://([A-Za-z0-9_=-]+)', code).group(1); enc += '=' * (-len(enc) % 4)
p = json.loads(base64.urlsafe_b64decode(enc))
doc = {"v": 1, "updatedAt": datetime.datetime.utcnow().isoformat() + "Z",
       "hosts": [{"id": "$X_HOST", "label": "$X_HOST", "baseUrl": p["baseUrl"], "token": p["token"], "transport": "http+sse",
                  "cloud": {"provider": "boat", "sandboxId": "$X_ID", "sessionId": "$X_HOST", "hostname": "$X_HOST", "version": 1}}]}
path = os.path.expanduser('~/.config/runpane-cloud/peers.json'); json.dump(doc, open(path, 'w')); os.chmod(path, 0o600)
PY
shred -u /home/user/rcl/peer-b.code
SH
orch_count() {  # deliveries = user-message entries in the orchestrator's Claude transcript carrying the framed marker
  sbx "$X_ID" 30 <<SH
cat ~/.claude/projects/*/*.jsonl 2>/dev/null | python3 -c "
import sys, json
n = 0
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    if d.get('type') != 'user' or d.get('isMeta'): continue
    c = (d.get('message') or {}).get('content')
    t = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in (c or []) if isinstance(x, dict))
    if 'peer message from' in t and '$1' in t: n += 1
print(n)"
SH
}
orch_line() { sbx "$X_ID" 30 <<<"cat ~/.claude/projects/*/*.jsonl 2>/dev/null | grep -o '\[peer message from [^]]*\] [a-z]* $1' | head -1"; }
lst=$(sbx "$A_ID" 60 <<<"/home/user/rcl/rp --host $X_HOST panels list --json"); printf '%s\n' "$lst" | ev a-panels-list.json >/dev/null
ids=$(python3 -c 'import json,sys
try: d=json.loads(sys.stdin.read())
except Exception: print("PARSE"); sys.exit()
print(",".join(p.get("id") or p.get("panelId") for p in d.get("panels",[])))' <<<"$lst")
[ "$ids" = "$ORCH" ] && g M3-peers a-list-orchestrator-only PASS "A: --host $X_HOST panels list -> only B's orchestrator panel" "$E2E_RUN_DIR/a-panels-list.json" \
  || g M3-peers a-list-orchestrator-only FAIL "A saw: $ids (orchestrator $ORCH)" "$E2E_RUN_DIR/a-panels-list.json"
M="e2e-peer-$RANDOM$RANDOM"; K="e2e-key-$RANDOM$RANDOM"
sbx "$A_ID" 120 <<<"/home/user/rcl/rp --host $X_HOST panels submit --panel $ORCH --text 'hello $M' --idempotency-key $K --yes --json" | ev a-submit-1.json >/dev/null
sleep 8; line=$(orch_line "$M")
[[ "$line" == *"peer message from $A_HOST] hello $M"* ]] && g M3-peers a-submit-framed PASS "landed in B's orchestrator panel as: $line" "$E2E_RUN_DIR/a-submit-1.json" \
  || g M3-peers a-submit-framed FAIL "orchestrator log line: '$line'" "$E2E_RUN_DIR/a-submit-1.json"
sbx "$A_ID" 120 <<<"/home/user/rcl/rp --host $X_HOST panels submit --panel $ORCH --text 'hello $M' --idempotency-key $K --yes --json" | ev a-submit-dup.json >/dev/null
sleep 3; n=$(orch_count "$M")
[ "$n" = 1 ] && g M3-peers idempotency-once PASS "same key twice -> delivered once" "$E2E_RUN_DIR/a-submit-dup.json" || g M3-peers idempotency-once FAIL "delivered $n times" "$E2E_RUN_DIR/a-submit-dup.json"
st() { jget 'str(d["http"])+" "+str((d["body"] or {}).get("error",{}).get("code","") if isinstance(d["body"],dict) else "")'; }
pinv() { cl remote invoke "$X_PAIR" "$1" "$2" --token-file "$3"; }
r=$(pinv runpane:panels:submit "[{\"panelId\":\"$SHELL_PANEL\",\"input\":\"echo pwned\"}]" "$PAT" | st); [[ "$r" == 403* ]] && g M3-peers peer-shell-403 PASS "peer submit to a shell -> $r" || g M3-peers peer-shell-403 FAIL "-> $r"
r=$(pinv runpane:repos:list '[{}]' "$PAT" | st); [[ "$r" == 403* ]] && g M3-peers peer-other-channel-403 PASS "peer repos:list -> $r" || g M3-peers peer-other-channel-403 FAIL "-> $r"
r=$(pinv runpane:report '[{"state":"done"}]' "$PAT" | st); [[ "$r" == 403* ]] && g M3-peers peer-report-403 PASS "peer report -> $r" || g M3-peers peer-report-403 FAIL "-> $r"
r=$(cl remote get "$X_PAIR" /events --token-file "$PAT" --timeout 5 | jget 'd["http"]'); [ "$r" = 403 ] && g M3-peers peer-events-403 PASS "peer GET /events -> 403" || g M3-peers peer-events-403 FAIL "-> $r"
r=$(cl remote ws "$X_PAIR" /events --token-file "$PAT" | jget 'd["http"]'); [ "$r" = 403 ] && g M3-peers peer-ws-403 PASS "peer WS upgrade -> 403" || g M3-peers peer-ws-403 FAIL "-> $r"
r=$(pinv runpane:panels:submit "[{\"panelId\":\"$ORCH\",\"input\":\"from C\"}]" "$PCT" | st); [[ "$r" == 403* ]] && g M3-peers non-allowlisted-403 PASS "non-allowlisted peer -> $r" || g M3-peers non-allowlisted-403 FAIL "-> $r"
r=$(pinv runpane:workspace:wait '[{"timeoutMs":1000}]' "$PAT" | st); [[ "$r" == 200* ]] && g M3-peers peer-workspace-wait PASS "peer workspace:wait allowed" || g M3-peers peer-workspace-wait FAIL "-> $r"
else g M3-peers peer-checks BLOCKED "no peer token (mint failed); peer checks not run"; fi

# ================================================================ stop/wake cycles on X (M1), power-off (M2), survive (M3)
for c in $(seq 1 "$CYCLES"); do
  t0=$(ms_now); so=$(rpc cloud stop "$X_HOST" --yes --json 2>&1); src=$?; ss=$(secs_since "$t0")
  arch=$(cl boat wait "$X_ID" archived --timeout 120); printf '%s\n%s\n' "$so" "$arch" | ev "cycle$c-stop.json" >/dev/null
  down=$(cl remote health "$X_PAIR" --timeout 4 | jget 'd["http"]'); sst=$(rpc cloud status "$X_HOST" --json 2>/dev/null | jget 'd.get("status")')
  [ $src = 0 ] && [ "$(jget 'd["state"]' <<<"$arch")" = archived ] && [ "$down" != 200 ] && [ "$sst" = asleep ] \
    && g M1-cli "cycle$c-stop" PASS "cloud stop ${ss}s; archived; /health down; status=asleep" "$E2E_RUN_DIR/cycle$c-stop.json" "seconds=$ss" \
    || g M1-cli "cycle$c-stop" FAIL "rc=$src boat=$(jget 'd["state"]' <<<"$arch") health=$down status=$sst" "$E2E_RUN_DIR/cycle$c-stop.json"
  t0=$(ms_now); wo=$(rpc cloud wake "$X_HOST" --json 2>&1); wrc=$?; ws=$(secs_since "$t0")
  hh=$(cl remote health "$X_PAIR" --timeout 5); printf '%s\n%s\n' "$wo" "$hh" | ev "cycle$c-wake.json" >/dev/null
  nn=$(cl ts find "$X_HOST" | jget '",".join(x["nodeId"] for x in d)'); inv=$(cl remote invoke "$X_PAIR" runpane:repos:list '[{}]' | jget 'd["http"]')
  rs=$(jget 'd["body"].get("readiness",{}).get("state","n/a") if isinstance(d["body"],dict) else "n/a"' <<<"$hh")
  [ $wrc = 0 ] && [ "$(jget 'd["http"]' <<<"$hh")" = 200 ] && [ "$rs" != starting ] && [ "$nn" = "$NODE" ] && [ "$inv" = 200 ] \
    && g M1-cli "cycle$c-wake" PASS "cloud wake ${ws}s, /health 200 right after (readiness=$rs), same node, old token works" "$E2E_RUN_DIR/cycle$c-wake.json" "seconds=$ws" \
    || g M1-cli "cycle$c-wake" FAIL "rc=$wrc ${ws}s health=$(jget 'd["http"]' <<<"$hh") readiness=$rs node=$nn invoke=$inv" "$E2E_RUN_DIR/cycle$c-wake.json"
  if [ "$c" = 1 ]; then
    [ -n "$VERSION" ] && [ "$VERSION" != null ] && [ "$(jget 'd["body"].get("version")' <<<"$hh")" = "$VERSION" ] && g M2-resume poweroff.version-stable PASS "version $VERSION after power-off" || g M2-resume poweroff.version-stable FAIL "version changed"
    after_kill poweroff "in lowercase letters with a dash between each letter (like a-b-c)" "$(sed 's/./&-/g; s/-$//' <<<"$LOW")"
    [ "$M3_OK" = 1 ] && {
    M2m="e2e-peer2-$RANDOM"
    sbx "$A_ID" 120 <<<"/home/user/rcl/rp --host $X_HOST panels submit --panel $ORCH --text 'again $M2m' --yes --json" | ev a-submit-after-resume.json >/dev/null
    sleep 3; n=$(orch_count "$M2m")
    [ "$n" = 1 ] && g M3-peers peer-survives-resume PASS "after B's power-off/resume A's peer token still delivers" "$E2E_RUN_DIR/a-submit-after-resume.json" \
      || g M3-peers peer-survives-resume FAIL "delivered $n times after resume" "$E2E_RUN_DIR/a-submit-after-resume.json"; }
  fi
done

# ================================================================ M3 revoke, M1 destroy
[ "$M3_OK" = 1 ] && { sbx "$X_ID" 60 <<<"/home/user/rcl/rp peers revoke --peer $A_HOST --yes --json" | ev revoke.json >/dev/null
r=$(pinv runpane:panels:list '[{}]' "$PAT" | st); [[ "$r" == 401* || "$r" == 403* ]] && g M3-peers revoke PASS "revoked peer -> $r" || g M3-peers revoke FAIL "-> $r"; }
if [ "${KEEP:-0}" != 1 ]; then
  t0=$(ms_now); rpc cloud destroy "$X_HOST" --yes --json > "$E2E_RUN_DIR/destroy.json" 2>&1; drc=$?; sleep 3
  sbs=$(cl boat get "$X_ID" --field state); nd=$(cl ts find "$X_HOST" | jget 'len(d)')
  [ $drc = 0 ] && { [ "$sbs" = gone ] || [ "$sbs" = archiving ]; } && [ "$nd" = 0 ] \
    && g M1-cli destroy PASS "cloud destroy $(secs_since "$t0")s: sandbox=$sbs, devices=$nd" "$E2E_RUN_DIR/destroy.json" \
    || g M1-cli destroy FAIL "rc=$drc sandbox=$sbs devices=$nd" "$E2E_RUN_DIR/destroy.json"
fi
