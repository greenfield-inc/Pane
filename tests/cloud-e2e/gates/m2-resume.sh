#!/usr/bin/env bash
# M2 gate, part 1: "kill -> wake -> panels submit works" (final-plan S4 M2), on a daemon build under test.
# For a shell panel and (when a Claude token is available) a Claude panel:
#   A. plain daemon restart (systemctl --user restart), then B. boat power-off (stop) + resume.
# After each: /health is back with version + readiness, `panels submit` to the SAME panel id is accepted,
# the shell runs the new command, and Claude continues the SAME conversation (it can answer from a fact
# given before the kill, lowercased so the answer never appears on screen before).
# Also samples /health.readiness during the wake to show the starting -> ready transition.
# Env: E2E_DAEMON_DEB_URL (default: dist-current .deb), E2E_RUNPANE_TGZ_URL, E2E_SIZE, E2E_CLAUDE=0|1
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/provision.sh"; . "$E2E_LIB/fixtures.sh"; . "$E2E_LIB/claude.sh"; . "$E2E_LIB/cli.sh"
export E2E_DAEMON_DEB_URL="${E2E_DAEMON_DEB_URL-$(dist_url deb)}"
E2E_TARGET="${E2E_TARGET:-${E2E_DAEMON_DEB_URL:-runpane@latest}}"; E2E_TARGET="${E2E_TARGET##*/}"
e2e_init M2-resume
wait_start_budget 2

provision_manual m2r "${E2E_SIZE:-default}" || exit 1
h0=$(cl remote wait-health "$SB_PAIRING" --timeout 120); printf '%s\n' "$h0" | ev health-initial.json >/dev/null
VERSION=$(jget 'd["body"].get("version") if isinstance(d["body"],dict) else None' <<<"$h0")
if [ -n "$VERSION" ] && [ "$VERSION" != null ] && [ "$VERSION" != None ]; then rec health-version PASS "/health reports version=$VERSION readiness=$(jget 'd["body"].get("readiness")' <<<"$h0")" "$E2E_RUN_DIR/health-initial.json"
else rec health-version FAIL "/health has no version field: $(jget 'd["body"]' <<<"$h0")" "$E2E_RUN_DIR/health-initial.json"; fi

fx=$(fixture_shell_pane "$SB_ID" m2shell | tail -1); SHELL_PANEL=$(jget 'd["panelId"]' <<<"$fx")
[ -n "$SHELL_PANEL" ] && [ "$SHELL_PANEL" != None ] || { rec fixture FAIL "shell pane not created: $fx"; exit 1; }
CLAUDE_PANEL=""
if claude_available; then
  cs=$(sandbox_claude_setup "$SB_ID" /home/user/e2e-repo/worktrees/m2claude 2>&1); printf '%s\n' "$cs" | ev claude-setup.txt >/dev/null
  cl remote wait-health "$SB_PAIRING" --timeout 60 >/dev/null
  fa=$(fixture_agent_pane "$SB_ID" m2claude claude | tail -1); printf '%s\n' "$fa" | ev claude-pane.json >/dev/null
  CLAUDE_PANEL=$(jget 'd["panelId"] or ""' <<<"$fa")
  [ -n "$CLAUDE_PANEL" ] || rec claude-fixture FAIL "claude pane not created: $fa" "$E2E_RUN_DIR/claude-pane.json"
fi
WORD=$(python3 -c 'import random,string;print("".join(random.choice(string.ascii_uppercase) for _ in range(8)))')
DROW=$(tr "[:upper:]" "[:lower:]" <<<"$WORD")   # the answer never appears on screen before the kill
if [ -n "$CLAUDE_PANEL" ]; then
  submit_invoke "$SB_PAIRING" "$CLAUDE_PANEL" "Remember this codeword for later: $WORD. Reply with only the word OK." | ev claude-pre-submit.json >/dev/null
  if wait_last_message "$SB_PAIRING" "$CLAUDE_PANEL" OK 120 | ev claude-pre-reply.json >/dev/null; then rec claude-before PASS "Claude panel $CLAUDE_PANEL answered before the kill" "$E2E_RUN_DIR/claude-pre-reply.json"
  else rec claude-before FAIL "Claude did not reply before the kill" "$E2E_RUN_DIR/claude-pre-reply.json"; CLAUDE_PANEL=""; fi
else rec claude-before SKIP "no Claude token available (E2E_CLAUDE=0 or no token command)"; fi

agent_session_of() {  # agentSessionId of the Claude panel, from panels list over /invoke
  cl remote invoke "$SB_PAIRING" runpane:panels:list "[{\"paneId\":\"$1\"}]" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);ps=(d.get("body",{}).get("result") or {}).get("panels",[])
print(next((p.get("agentSessionId") or (p.get("agent") or {}).get("sessionId") or "" for p in ps if p.get("id")==sys.argv[1]),""))' "$CLAUDE_PANEL" 2>/dev/null
}
CLAUDE_PANE=""; [ -n "${fa:-}" ] && CLAUDE_PANE=$(jget 'd.get("paneId") or ""' <<<"$fa")
SID_BEFORE=$([ -n "$CLAUDE_PANEL" ] && agent_session_of "$CLAUDE_PANE")

# after_kill <phase> : the checks that must hold after any kill
after_kill() {
  local phase="$1" m="e2e-$phase-$RANDOM" out
  out=$(submit_invoke "$SB_PAIRING" "$SHELL_PANEL" "echo $m"); printf '%s\n' "$out" | ev "$phase-shell-submit.json" >/dev/null
  if [ "$(jget 'd["http"]' <<<"$out")" = 200 ] && wait_screen "$SB_PAIRING" "$SHELL_PANEL" "$m" 30; then
    rec "$phase.shell-submit" PASS "same shell panel $SHELL_PANEL accepted submit and ran it" "$E2E_RUN_DIR/$phase-shell-submit.json"
  elif grep -q 'not initialized' <<<"$out"; then rec "$phase.shell-submit" FAIL "'not initialized' (the M2 bug)" "$E2E_RUN_DIR/$phase-shell-submit.json"
  else rec "$phase.shell-submit" FAIL "submit http=$(jget 'd["http"]' <<<"$out") or output never appeared" "$E2E_RUN_DIR/$phase-shell-submit.json"; fi
  [ -n "$CLAUDE_PANEL" ] || { rec "$phase.claude-continues" SKIP "no Claude panel"; return; }
  # each phase asks for a different form, so a stale reply from an earlier phase can never match
  local want ask
  case "$phase" in
    restart) want="$DROW"; ask="Reply with only the codeword written in lowercase letters, nothing else." ;;
    *) want=$(sed 's/./&-/g; s/-$//' <<<"$DROW"); ask="Reply with only the codeword in lowercase letters with a dash between each letter (like a-b-c), nothing else." ;;
  esac
  out=$(submit_invoke "$SB_PAIRING" "$CLAUDE_PANEL" "What was the codeword I gave you before? $ask")
  printf '%s\n' "$out" | ev "$phase-claude-submit.json" >/dev/null
  if [ "$(jget 'd["http"]' <<<"$out")" != 200 ]; then rec "$phase.claude-continues" FAIL "submit http=$(jget 'd["http"]' <<<"$out"): $(head -c 200 <<<"$out")" "$E2E_RUN_DIR/$phase-claude-submit.json"; return; fi
  local sid_now; sid_now=$(agent_session_of "$CLAUDE_PANE")
  if wait_last_message "$SB_PAIRING" "$CLAUDE_PANEL" "$want" 180 | ev "$phase-claude-reply.json" >/dev/null; then
    rec "$phase.claude-continues" PASS "same Claude panel answered '$want' (a new form of the codeword) from pre-kill context (agent session ${SID_BEFORE:-?} -> ${sid_now:-?})" "$E2E_RUN_DIR/$phase-claude-reply.json"
  else rec "$phase.claude-continues" FAIL "no reply containing '$want' (session ${SID_BEFORE:-?} -> ${sid_now:-?})" "$E2E_RUN_DIR/$phase-claude-reply.json"; fi
}

# sample_readiness <seconds> : background sampler of /health readiness states during a wake
sample_readiness() {
  local end=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    cl remote health "$SB_PAIRING" --timeout 2 | jget '"%s %s %s" % (d["http"], (d["body"] or {}).get("readiness",{}).get("state") if isinstance(d["body"],dict) else "-", (d["body"] or {}).get("readiness",{}).get("agents") if isinstance(d["body"],dict) else "-")' 2>/dev/null
    sleep 0.3
  done | uniq
}

# ---- A. plain daemon restart
t0=$(ms_now)
sbx "$SB_ID" 60 <<<'systemctl --user restart pane-remote-daemon.service; echo restarted rc=$?' | ev restart.txt >/dev/null
wh=$(cl remote wait-health "$SB_PAIRING" --timeout 120 --require 'h.get("readiness",{}).get("state","ready")!="starting"'); rs=$(secs_since "$t0")
printf '%s\n' "$wh" | ev restart-health.json >/dev/null
[ "$(jget 'd["http"]' <<<"$wh")" = 200 ] && rec restart.health PASS "/health ready ${rs}s after restart (readiness=$(jget 'd["body"].get("readiness")' <<<"$wh"))" "$E2E_RUN_DIR/restart-health.json" "seconds=$rs" \
  || rec restart.health FAIL "no ready /health after restart" "$E2E_RUN_DIR/restart-health.json"
after_kill restart

# ---- B. boat power-off + resume (no SIGTERM, M0)
cl boat stop "$SB_ID" >/dev/null; arch=$(cl boat wait "$SB_ID" archived --timeout 180)
[ "$(jget 'd["state"]' <<<"$arch")" = archived ] || { rec poweroff.stop FAIL "never archived: $arch"; exit 1; }
t0=$(ms_now); cl boat resume "$SB_ID" >/dev/null
sample_readiness 60 | ev poweroff-readiness-samples.txt >/dev/null &
SAMPLER=$!
wh=$(cl remote wait-health "$SB_PAIRING" --timeout 180 --require 'h.get("readiness",{}).get("state","ready")!="starting"'); ws=$(secs_since "$t0")
wait "$SAMPLER" 2>/dev/null
printf '%s\n' "$wh" | ev poweroff-health.json >/dev/null
states=$(awk '{print $2}' "$E2E_RUN_DIR/poweroff-readiness-samples.txt" | uniq | tr '\n' '>' )
[ "$(jget 'd["http"]' <<<"$wh")" = 200 ] && rec poweroff.health PASS "resume -> /health ready in ${ws}s; readiness sequence: ${states%>}; version=$(jget 'd["body"].get("version")' <<<"$wh")" "$E2E_RUN_DIR/poweroff-readiness-samples.txt" "seconds=$ws" \
  || rec poweroff.health FAIL "no ready /health after resume" "$E2E_RUN_DIR/poweroff-health.json"
[ -n "$VERSION" ] && [ "$VERSION" != null ] && [ "$(jget 'd["body"].get("version")' <<<"$wh")" = "$VERSION" ] && rec poweroff.version-stable PASS "same version $VERSION after resume" || rec poweroff.version-stable FAIL "version changed: $VERSION -> $(jget 'd["body"].get("version")' <<<"$wh")"
after_kill poweroff

pl=$(cl remote invoke "$SB_PAIRING" runpane:panels:list "[{\"paneId\":\"$(jget 'd["paneId"]' <<<"$fx")\"}]"); printf '%s\n' "$pl" | ev panels-list-after.json >/dev/null
rec panels-list-state INFO "panels list after resume: $(jget '[{k:p.get(k) for k in ("title","initialized","interrupted","resumable","state") if k in p} for p in d["body"]["result"]["panels"] if p.get("type")=="terminal"]' <<<"$pl" 2>/dev/null | head -c 300)" "$E2E_RUN_DIR/panels-list-after.json"
