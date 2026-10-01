#!/usr/bin/env bash
# M2 gate, part 2: safe-to-stop (final-plan S4 M2 + blocking problem 3, P7).
#   safe when idle; refuses in each of the 6 conditions (agent-working, recent-terminal-output, lock-held,
#   watcher-active, pr-checks-pending, user-client-attached); a DB write made right before a flush survives
#   an immediate boat power-off; the in-sandbox CLI exits 0 (safe) / 3 (blocked).
# Surface: POST /invoke runpane:cloud:safe-to-stop (exempt from user-client activity by contract) and the
#   in-sandbox `runpane` CLI. Fixtures are driven over the local socket so the gate itself is not a user client
#   until the user-client step, which runs last.
# pr-checks-pending uses a fake `gh` on the daemon's PATH (the external-tool seam) that reports a pending check.
# Env: E2E_DAEMON_DEB_URL (default dist-current .deb), E2E_CLAUDE=0|1
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/provision.sh"; . "$E2E_LIB/fixtures.sh"; . "$E2E_LIB/claude.sh"; . "$E2E_LIB/cli.sh"
export E2E_DAEMON_DEB_URL="${E2E_DAEMON_DEB_URL-$(dist_url deb)}"
E2E_TARGET="${E2E_TARGET:-${E2E_DAEMON_DEB_URL:-runpane@latest}}"; E2E_TARGET="${E2E_TARGET##*/}"
e2e_init M2-safestop
wait_start_budget 2

provision_manual m2s "${E2E_SIZE:-default}" || exit 1
cl remote wait-health "$SB_PAIRING" --timeout 120 >/dev/null

# ss <label> [args-json] -> saves result, echoes the blocker conditions (comma list) or "SAFE" / "ERR:<http>"
ss() {
  local args='[{"flush":"never","recentOutputMs":10000,"clientWindowMs":900000}]'
  local out; out=$(cl remote invoke "$SB_PAIRING" runpane:cloud:safe-to-stop "${2:-$args}")
  printf '%s\n' "$out" > "$E2E_RUN_DIR/ss-$1.json"
  python3 - "$E2E_RUN_DIR/ss-$1.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if d.get("http")!=200: print(f"ERR:{d.get('http')}:{json.dumps(d.get('body'))[:160]}"); sys.exit()
r=d["body"]["result"]
print("SAFE" if r.get("safe") else ",".join(sorted({b.get("condition","?") for b in r.get("blockers",[])})) or "UNSAFE-NO-BLOCKERS")
PY
}
# expect <check> <label> <condition> : PASS if the condition is among the blockers
expect() {
  local got; got=$(ss "$2")
  if [[ ",$got," == *",$3,"* ]]; then rec "$1" PASS "refused with $3 (blockers: $got)" "$E2E_RUN_DIR/ss-$2.json"
  elif [[ "$got" == ERR:404* ]]; then rec "$1" BLOCKED "runpane:cloud:safe-to-stop not in this build" "$E2E_RUN_DIR/ss-$2.json"
  else rec "$1" FAIL "expected $3, got: $got" "$E2E_RUN_DIR/ss-$2.json"; fi
}
expect_clear() {  # expect_clear <check> <label> <condition> [timeout]
  local end=$(( $(date +%s) + ${4:-60} )) got
  while [ "$(date +%s)" -lt "$end" ]; do got=$(ss "$2"); [[ ",$got," != *",$3,"* ]] && break; sleep 3; done
  [[ ",$got," != *",$3,"* ]] && rec "$1" PASS "$3 cleared (now: $got)" "$E2E_RUN_DIR/ss-$2.json" || rec "$1" FAIL "$3 still reported" "$E2E_RUN_DIR/ss-$2.json"
}

fx=$(fixture_shell_pane "$SB_ID" m2sshell | tail -1); PANE=$(jget 'd["paneId"]' <<<"$fx"); SHELL_PANEL=$(jget 'd["panelId"]' <<<"$fx")
printf '%s\n' "$fx" | ev fixture.json >/dev/null

# ---- 0. idle -> safe
got=SAFE; end=$(( $(date +%s) + 45 ))
until [ "$(date +%s)" -ge "$end" ]; do got=$(ss idle); [ "$got" = SAFE ] && break; sleep 4; done
case "$got" in
  SAFE) rec safe-when-idle PASS "idle daemon answers safe:true" "$E2E_RUN_DIR/ss-idle.json" ;;
  ERR:404*) rec safe-when-idle BLOCKED "runpane:cloud:safe-to-stop not in this build ($E2E_TARGET)" "$E2E_RUN_DIR/ss-idle.json"; exit 0 ;;
  *) rec safe-when-idle FAIL "idle daemon not safe: $got" "$E2E_RUN_DIR/ss-idle.json" ;;
esac

# ---- 1. recent-terminal-output
rp_in "$SB_ID" panels submit --panel "$SHELL_PANEL" --text 'for i in $(seq 1 25); do echo tick $i; sleep 1; done' --yes --json >/dev/null
sleep 3; expect cond.recent-terminal-output output recent-terminal-output
expect_clear clear.recent-terminal-output output-after recent-terminal-output 60

# ---- 2. lock-held
rp_in "$SB_ID" lock acquire --name e2e-lock --ttl 10m --pane "$PANE" --json | ev lock-acquire.json >/dev/null
expect cond.lock-held lock lock-held
rp_in "$SB_ID" lock release --name e2e-lock --pane "$PANE" --json | ev lock-release.json >/dev/null
expect_clear clear.lock-held lock-after lock-held 20

# ---- 3. watcher-active (a long-poll `runpane watch` running in the sandbox)
sbx "$SB_ID" 30 <<'SH' >/dev/null
nohup timeout 25 /home/user/rcl/rp watch --follow >/home/user/rcl/watch.log 2>&1 &
sleep 2; echo started
SH
expect cond.watcher-active watch watcher-active
expect_clear clear.watcher-active watch-after watcher-active 180   # abandoned long-poll stays in flight until its server timeout, then 30 s grace

# ---- 4. agent-working (Claude runs a slow tool call)
if claude_available; then
  sandbox_claude_setup "$SB_ID" /home/user/e2e-repo/worktrees/m2sclaude >/dev/null 2>&1
  cl remote wait-health "$SB_PAIRING" --timeout 60 >/dev/null
  fa=$(fixture_agent_pane "$SB_ID" m2sclaude claude | tail -1); AP=$(jget 'd["panelId"] or ""' <<<"$fa")
  if [ -n "$AP" ]; then
    rp_in "$SB_ID" panels submit --panel "$AP" --text 'Use your Bash tool to run exactly: sleep 40 && echo slept. Then reply with only DONE.' --yes --json >/dev/null
    working=""; end=$(( $(date +%s) + 30 ))
    until [ "$(date +%s)" -ge "$end" ]; do g=$(ss agent); [[ ",$g," == *",agent-working,"* ]] && { working=1; break; }; sleep 2; done
    [ -n "$working" ] && rec cond.agent-working PASS "refused with agent-working while Claude ran a 40 s tool call" "$E2E_RUN_DIR/ss-agent.json" \
      || rec cond.agent-working FAIL "agent-working never reported (last: $g)" "$E2E_RUN_DIR/ss-agent.json"
    expect_clear clear.agent-working agent-after agent-working 120
  else rec cond.agent-working FAIL "Claude pane not created: $fa"; fi
else rec cond.agent-working SKIP "no Claude token (E2E_CLAUDE=0)"; fi

# ---- 5. pr-checks-pending (fake gh on the daemon's PATH; the pane must be a Session member)
sbx "$SB_ID" 60 <<'SH' | ev fake-gh.txt >/dev/null
sudo tee /usr/local/bin/gh >/dev/null <<'GH'
#!/bin/bash
# rc-loop e2e fake gh: one open PR whose checks are still running
case "$1 $2" in
  "pr list") echo '[{"number":4242,"url":"https://github.com/example/e2e/pull/4242","title":"e2e","state":"OPEN","isDraft":false,"body":""}]';;
  "pr view") echo '{"number":4242,"url":"https://github.com/example/e2e/pull/4242","state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[{"name":"ci","status":"IN_PROGRESS","conclusion":""}],"headRefOid":"0000000000000000000000000000000000000000"}';;
  "auth status") echo "Logged in to github.com as e2e"; exit 0;;
  *) exit 0;;
esac
GH
sudo chmod 755 /usr/local/bin/gh
cd /home/user/e2e-repo && git remote add origin https://github.com/example/e2e.git 2>/dev/null; true
echo '{"name":"e2e-prs","launchCommand":"bash"}' | /home/user/rcl/rp sessions create --from-json - --json > /home/user/rcl/session.json
echo "session: $(python3 -c "import json;print(json.load(open('/home/user/rcl/session.json'))['session'].get('id'))")"
SH
SESSION=$(sbx "$SB_ID" 30 <<<"python3 -c \"import json;print(json.load(open('/home/user/rcl/session.json'))['session'].get('id'))\"")
rp_in "$SB_ID" sessions associate --session "$SESSION" --pane "$PANE" --json | ev session-associate.json >/dev/null
prs=""; end=$(( $(date +%s) + 90 ))
until [ "$(date +%s)" -ge "$end" ]; do g=$(ss pr); [[ ",$g," == *",pr-checks-pending,"* ]] && { prs=1; break; }; sleep 5; done
[ -n "$prs" ] && rec cond.pr-checks-pending PASS "refused with pr-checks-pending (fake gh: PR #4242 IN_PROGRESS; pane in Session $SESSION)" "$E2E_RUN_DIR/ss-pr.json" \
  || rec cond.pr-checks-pending FAIL "pr-checks-pending never reported (last: $g); see fake-gh.txt" "$E2E_RUN_DIR/ss-pr.json"
sbx "$SB_ID" 60 <<'SH' | ev pr-diagnostics.txt >/dev/null
echo "== daemon PATH: $(tr '\0' '\n' < /proc/$(pgrep -u user -f 'pane.*remote' | head -1)/environ 2>/dev/null | grep '^PATH=')"
echo "== which gh: $(command -v gh)"; echo "== worktree branch: $(git -C /home/user/e2e-repo/worktrees/m2sshell branch --show-current)"
echo "== overview:"; /home/user/rcl/rp sessions overview --session e2e-prs --json 2>&1 | head -c 1500; echo
echo "== daemon log (PR monitor / gh):"; journalctl --user -u pane-remote-daemon --no-pager 2>/dev/null | grep -iE 'PrMonitor|gh pr|github' | tail -20
SH
sbx "$SB_ID" 30 <<<'sudo rm -f /usr/local/bin/gh' >/dev/null
rp_in "$SB_ID" sessions detach --session "$SESSION" --pane "$PANE" --json >/dev/null

# ---- 6. flush then immediate power-off: a DB write made just before safe-to-stop survives
NEWNAME="e2e-renamed-$RANDOM"
rp_in "$SB_ID" panes rename --pane "$PANE" --name "$NEWNAME" --yes --json | ev rename.json >/dev/null
fl=$(cl remote invoke "$SB_PAIRING" runpane:cloud:safe-to-stop '[{"flush":"always"}]'); printf '%s\n' "$fl" | ev flush.json >/dev/null
cl boat stop "$SB_ID" >/dev/null   # immediately: M0 snapshot point is ~3.6-4.7 s after this call
flushed=$(jget '"yes" if d["body"]["result"].get("flush") else "no"' <<<"$fl" 2>/dev/null)
cl boat wait "$SB_ID" archived --timeout 180 >/dev/null; cl boat resume "$SB_ID" >/dev/null
cl remote wait-health "$SB_PAIRING" --timeout 180 >/dev/null
names=$(rp_in "$SB_ID" panes list --repo e2e-repo --json); printf '%s\n' "$names" | ev panes-after-resume.json >/dev/null
if grep -qF "$NEWNAME" <<<"$names" && [ "$flushed" = yes ]; then rec flush-survives-poweroff PASS "rename -> safe-to-stop flush:always ($(jget 'd["body"]["result"]["flush"]' <<<"$fl" | head -c 160)) -> immediate boat stop -> resume: rename persisted" "$E2E_RUN_DIR/flush.json"
else rec flush-survives-poweroff FAIL "flush=$flushed; renamed pane present after resume: $(grep -cF "$NEWNAME" <<<"$names")" "$E2E_RUN_DIR/panes-after-resume.json"; fi

# ---- 7. user-client-attached (runs last: it makes the gate itself a user client)
cl remote hold "$SB_PAIRING" /events --seconds 25 > "$E2E_RUN_DIR/events-hold.json" &
HOLD=$!; sleep 4
expect cond.user-client-attached.events events user-client-attached
wait $HOLD
cl remote invoke "$SB_PAIRING" runpane:repos:list '[{}]' >/dev/null     # a user /invoke within the window
expect cond.user-client-attached.invoke invoke user-client-attached
g=$(ss window '[{"flush":"never","recentOutputMs":10000,"clientWindowMs":1}]')
[[ ",$g," != *",user-client-attached,"* ]] && rec user-client-window PASS "outside the client window the user client no longer blocks (now: $g)" "$E2E_RUN_DIR/ss-window.json" \
  || rec user-client-window FAIL "still blocked with clientWindowMs=1" "$E2E_RUN_DIR/ss-window.json"
cli=$(sbx "$SB_ID" 60 <<<'/home/user/rcl/rp cloud safe-to-stop --dry-run --json 2>&1; echo "exit=$?"'); printf '%s\n' "$cli" | ev cli-safe-to-stop.txt >/dev/null
if grep -q '^exit=3' <<<"$cli" && grep -q '"safe": *false' <<<"$cli"; then rec cli-exit-code PASS "in-sandbox 'runpane cloud safe-to-stop' exit 3 with safe:false while blocked" "$E2E_RUN_DIR/cli-safe-to-stop.txt"
else rec cli-exit-code FAIL "unexpected CLI result: $(tail -c 200 <<<"$cli")" "$E2E_RUN_DIR/cli-safe-to-stop.txt"; fi
