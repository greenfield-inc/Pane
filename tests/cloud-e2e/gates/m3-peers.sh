#!/usr/bin/env bash
# M3 gate: peers (final-plan S3/S4 M3, blocking problems 1 and 6).
# Two cloud Sessions A and B on the tailnet with the build under test.
#   B mints a peer record for A (allowlisted to B's Session) and one for C (no allowlist).
#   A -> B over the tailnet with the runpane CLI (`--host`): panels list shows only the orchestrator panel;
#   submit lands in B's orchestrator panel framed "[peer message from <A>]"; the same idempotency key executes once.
#   With the peer token: submit to a shell -> 403; other channels -> 403; GET /events -> 403; WS upgrade -> 403;
#   non-allowlisted peer -> 403; revoked peer -> refused; peer records survive B's power-off/resume.
# B's orchestrator panel runs a line logger (launchCommand), so each delivery is one line in a file we can count.
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/provision.sh"; . "$E2E_LIB/fixtures.sh"; . "$E2E_LIB/cli.sh"; . "$E2E_LIB/claude.sh"
export E2E_DAEMON_DEB_URL="${E2E_DAEMON_DEB_URL-$(dist_url deb)}"
E2E_TARGET="${E2E_TARGET:-${E2E_DAEMON_DEB_URL:-runpane@latest}}"; E2E_TARGET="${E2E_TARGET##*/}"
e2e_init M3-peers
wait_start_budget 3

provision_manual m3b "${E2E_SIZE:-small}" || exit 1
B_ID=$SB_ID; B_HOST=$SB_HOST; B_PAIR=$SB_PAIRING; B_BASE=$SB_BASE
provision_manual m3a "${E2E_SIZE:-small}" || exit 1
A_ID=$SB_ID; A_HOST=$SB_HOST
cl remote wait-health "$B_PAIR" --timeout 120 >/dev/null

# ---- B: a shell pane, an orchestration Session whose orchestrator panel logs each line it receives
fx=$(fixture_shell_pane "$B_ID" m3shell | tail -1); SHELL_PANEL=$(jget 'd["panelId"]' <<<"$fx")
# B's orchestrator must be a real agent: peer submits go only into an agent composer (agentOnly), by design.
sandbox_claude_setup "$B_ID" /home/user > "$E2E_RUN_DIR/b-claude-setup.txt" 2>&1
cl remote wait-health "$B_PAIR" --timeout 90 >/dev/null
sess=$(sbx "$B_ID" 180 <<'SH'
echo '{"name":"e2e-b","agent":"claude"}' | /home/user/rcl/rp sessions create --from-json - --json > /home/user/rcl/session.json
p=$(python3 -c "import json;print(json.load(open('/home/user/rcl/session.json')).get('panelId',''))")
/home/user/rcl/rp panels wait --panel "$p" --for ready --timeout-ms 120000 --json > /home/user/rcl/orch-wait.json 2>&1
cat /home/user/rcl/session.json
SH
); printf '%s\n' "$sess" | ev b-session.json >/dev/null
B_SESSION=$(jget 'd["session"].get("id")' <<<"$sess" 2>/dev/null); ORCH=$(jget 'd.get("panelId")' <<<"$sess" 2>/dev/null)
[ -n "$ORCH" ] && [ "$ORCH" != null ] || { rec fixture FAIL "orchestration Session not created on B" "$E2E_RUN_DIR/b-session.json"; exit 1; }

MINT_SB=$B_ID
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
ma=$(mint "$A_HOST" "$B_SESSION"); printf '%s\n' "$ma" | ev mint-a.json >/dev/null
mc=$(mint rp-loop-e2e-c); printf '%s\n' "$mc" | ev mint-c.json >/dev/null
if grep -q 'pane-remote://' "$E2E_RUN_DIR/mint-a.json"; then rec mint-no-leak FAIL "code reached evidence"; else rec mint-no-leak PASS "code captured into a 0600 file in the sandbox; not in evidence"; fi
PA="$E2E_SECRETS/peer-a.code"; PC="$E2E_SECRETS/peer-c.code"
cl boat fetch "$B_ID" "/home/user/rcl/peer-$A_HOST.code" "$PA" && cl boat fetch "$B_ID" /home/user/rcl/peer-rp-loop-e2e-c.code "$PC" \
  || { rec mint FAIL "peers mint did not write code files (is 'runpane peers' in this build?)" "$E2E_RUN_DIR/mint-a.json"; exit 1; }
rec mint PASS "B minted peer records for A (allowlisted to Session $B_SESSION) and C (no allowlist)" "$E2E_RUN_DIR/mint-a.json"
cl remote pairing-mode "$PA" | jget 'd["baseUrl"]' | grep -q "$B_HOST" && rec peer-code-target PASS "A's code points at B's tailnet URL" || rec peer-code-target FAIL "A's code baseUrl is not B"
tokfile() { (umask 077; python3 -c 'import sys,json;sys.path.insert(0,sys.argv[2]);import cloudlab;print(cloudlab.read_pairing(sys.argv[1])["token"])' "$1" "$E2E_LIB" > "$1.tok"); echo "$1.tok"; }
PAT=$(tokfile "$PA"); PCT=$(tokfile "$PC")
orch_count() {  # deliveries = user-message entries in the orchestrator's Claude transcript carrying the framed marker
  sbx "$B_ID" 30 <<SH
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
orch_line() { sbx "$B_ID" 30 <<<"cat ~/.claude/projects/*/*.jsonl 2>/dev/null | grep -o '\[peer message from [^]]*\] [a-z]* $1' | head -1"; }
peer_inv() { cl remote invoke "$B_PAIR" "$1" "$2" --token-file "$3"; }  # B's baseUrl, peer token

# ---- A: peers file + CLI transport over the tailnet (the real peer path)
cl boat put "$A_ID" "$PA" rcl/peer-b.code >/dev/null
aset=$(sbx "$A_ID" 60 <<SH
set -e; umask 077; mkdir -p ~/.config/runpane-cloud
python3 - <<'PY'
import base64, json, os, re, datetime
code = open('/home/user/rcl/peer-b.code').read()
enc = re.search(r'pane-remote://([A-Za-z0-9_=-]+)', code).group(1); enc += '=' * (-len(enc) % 4)
p = json.loads(base64.urlsafe_b64decode(enc))
doc = {"v": 1, "updatedAt": datetime.datetime.utcnow().isoformat() + "Z",
       "hosts": [{"id": "$B_HOST", "label": "$B_HOST", "baseUrl": p["baseUrl"], "token": p["token"], "transport": "http+sse",
                  "cloud": {"provider": "boat", "sandboxId": "$B_ID", "sessionId": "$B_HOST", "hostname": "$B_HOST", "version": 1}}]}
path = os.path.expanduser('~/.config/runpane-cloud/peers.json')
json.dump(doc, open(path, 'w')); os.chmod(path, 0o600)
PY
shred -u /home/user/rcl/peer-b.code; echo ok
SH
)
lst=$(sbx "$A_ID" 60 <<<"/home/user/rcl/rp --host $B_HOST panels list --json"); printf '%s\n' "$lst" | ev a-panels-list.json >/dev/null
ids=$(python3 -c 'import json,sys
try: d=json.loads(sys.stdin.read())
except Exception: print("PARSE"); sys.exit()
print(",".join(p.get("id") or p.get("panelId") for p in d.get("panels",[])))' <<<"$lst")
[ "$ids" = "$ORCH" ] && rec a-list-orchestrator-only PASS "A: runpane --host $B_HOST panels list -> only B's orchestrator panel" "$E2E_RUN_DIR/a-panels-list.json" \
  || rec a-list-orchestrator-only FAIL "A saw panels: $ids (orchestrator $ORCH)" "$E2E_RUN_DIR/a-panels-list.json"
M="e2e-peer-$RANDOM$RANDOM"; K="e2e-key-$RANDOM$RANDOM"
s1=$(sbx "$A_ID" 90 <<<"/home/user/rcl/rp --host $B_HOST panels submit --panel $ORCH --text 'hello $M' --idempotency-key $K --yes --json"); printf '%s\n' "$s1" | ev a-submit-1.json >/dev/null
sleep 3
sleep 5; line=$(orch_line "$M")
if [[ "$line" == *"peer message from $A_HOST] hello $M"* ]]; then rec a-submit-framed PASS "landed in B's orchestrator panel as: $line" "$E2E_RUN_DIR/a-submit-1.json"
else rec a-submit-framed FAIL "orchestrator log line: '$line'" "$E2E_RUN_DIR/a-submit-1.json"; fi
s2=$(sbx "$A_ID" 90 <<<"/home/user/rcl/rp --host $B_HOST panels submit --panel $ORCH --text 'hello $M' --idempotency-key $K --yes --json"); printf '%s\n' "$s2" | ev a-submit-dup.json >/dev/null
sleep 8; n=$(orch_count "$M")
[ "$n" = 1 ] && rec idempotency-once PASS "same idempotency key sent twice -> delivered once (dedup: $(grep -o '"deduplicated": *[a-z]*' <<<"$s2"))" "$E2E_RUN_DIR/a-submit-dup.json" \
  || rec idempotency-once FAIL "delivered $n times" "$E2E_RUN_DIR/a-submit-dup.json"

# ---- peer token directly against B's API
st() { jget 'str(d["http"])+" "+str((d["body"] or {}).get("error",{}).get("code","") if isinstance(d["body"],dict) else "")'; }
r=$(peer_inv runpane:panels:submit "[{\"panelId\":\"$SHELL_PANEL\",\"input\":\"echo pwned\"}]" "$PAT" | st)
[[ "$r" == 403* ]] && rec peer-shell-403 PASS "peer submit to a shell panel -> $r" || rec peer-shell-403 FAIL "peer submit to shell -> $r"
r=$(peer_inv runpane:repos:list '[{}]' "$PAT" | st)
[[ "$r" == 403* ]] && rec peer-other-channel-403 PASS "peer runpane:repos:list -> $r" || rec peer-other-channel-403 FAIL "-> $r"
r=$(peer_inv runpane:report '[{"state":"done"}]' "$PAT" | st)
[[ "$r" == 403* ]] && rec peer-report-403 PASS "peer runpane:report -> $r" || rec peer-report-403 FAIL "-> $r"
r=$(cl remote get "$B_PAIR" /events --token-file "$PAT" --timeout 5 | jget 'd["http"]')
[ "$r" = 403 ] && rec peer-events-403 PASS "peer GET /events -> 403" || rec peer-events-403 FAIL "peer GET /events -> $r"
r=$(cl remote ws "$B_PAIR" /events --token-file "$PAT" | jget 'd["http"]')
[ "$r" = 403 ] && rec peer-ws-403 PASS "peer WebSocket upgrade -> 403" || rec peer-ws-403 FAIL "peer WS upgrade -> $r"
r=$(peer_inv runpane:panels:submit "[{\"panelId\":\"$ORCH\",\"input\":\"from C\"}]" "$PCT" | st)
[[ "$r" == 403* ]] && rec non-allowlisted-403 PASS "non-allowlisted peer submit to orchestrator -> $r" || rec non-allowlisted-403 FAIL "-> $r"
r=$(peer_inv runpane:workspace:wait '[{"timeoutMs":1000}]' "$PAT" | st)
[[ "$r" == 200* ]] && rec peer-workspace-wait PASS "peer runpane:workspace:wait allowed (forced to the allowlisted Session)" || rec peer-workspace-wait FAIL "peer workspace:wait -> $r"
ev_user=$(cl remote get "$B_PAIR" /events --timeout 3 | jget 'd["http"]')
[ "$ev_user" = 200 ] && rec user-events-still-200 PASS "a user client still gets /events (only peers are rejected)" || rec user-events-still-200 INFO "user /events -> $ev_user"

# ---- peer records survive B's power-off/resume
cl boat stop "$B_ID" >/dev/null; cl boat wait "$B_ID" archived --timeout 180 >/dev/null; cl boat resume "$B_ID" >/dev/null
cl remote wait-health "$B_PAIR" --timeout 180 >/dev/null
M2="e2e-peer2-$RANDOM"
s3=$(sbx "$A_ID" 120 <<<"/home/user/rcl/rp --host $B_HOST panels submit --panel $ORCH --text 'again $M2' --yes --json"); printf '%s\n' "$s3" | ev a-submit-after-resume.json >/dev/null
sleep 3; n=$(orch_count "$M2")
[ "$n" = 1 ] && rec peer-survives-resume PASS "after B's power-off/resume, A's peer token still delivers (records on disk)" "$E2E_RUN_DIR/a-submit-after-resume.json" \
  || rec peer-survives-resume FAIL "delivered $n times after resume" "$E2E_RUN_DIR/a-submit-after-resume.json"

# ---- revoke
sbx "$B_ID" 60 <<<"/home/user/rcl/rp peers revoke --peer $A_HOST --yes --json" | ev revoke.json >/dev/null
r=$(peer_inv runpane:panels:list '[{}]' "$PAT" | st)
[[ "$r" == 401* || "$r" == 403* ]] && rec revoke PASS "revoked peer -> $r" || rec revoke FAIL "revoked peer -> $r"
