#!/usr/bin/env bash
# Runpane Cloud morning smoke: prove YOUR setup works end to end, in about 5 minutes.
#
#   tests/cloud-e2e/morning-smoke.sh            # uses your `runpane` and your `runpane cloud setup`
#   tests/cloud-e2e/morning-smoke.sh --keep     # leave the cloud Session running afterwards
#
# Before running it once:
#   1. Install the runpane CLI build that has `runpane cloud` (see ~/rc-loop/results/dist-current.md, or
#      `npm i -g <runpane tarball URL>`), and check `runpane version`.
#   2. `runpane cloud setup` with your boat key, Tailscale OAuth client and (optionally) Anthropic key.
#   3. This machine must be on the same tailnet (`tailscale status`).
#
# What it does, using only the product surface (`runpane cloud ...`, `runpane --host ...`, /health, /invoke):
#   new -> health over the tailnet -> a shell Pane in the cloud Session -> submit a command and read it back
#   -> stop -> status asleep -> wake -> submit to the SAME panel again -> (optional) desktop check -> destroy.
# It prints a PASS/FAIL table and keeps evidence (no tokens) in ~/runpane-cloud-smoke/<time>/.
# Loop-only: --loop runs it on the build loop's machine with an isolated config made from the loop's keys
# (E2E_GOLDEN=<named snapshot> to create from a golden, else E2E_DAEMON_DEB_URL / the dist-current .deb).
set -o pipefail
KEEP_HOST=0; LOOP=0; SIZE="${SMOKE_SIZE:-small}"; REPO="${SMOKE_REPO:-https://github.com/octocat/Hello-World.git}"
for a in "$@"; do case "$a" in --keep) KEEP_HOST=1;; --loop) LOOP=1;; -h|--help) sed -n 2,20p "$0"; exit 0;; esac; done

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ "$LOOP" = 1 ]; then
  export E2E_EVIDENCE_ROOT="${E2E_EVIDENCE_ROOT:-$HOME/rc-loop/evidence/e2e-gates}"
else
  export E2E_EVIDENCE_ROOT="${E2E_EVIDENCE_ROOT:-$HOME/runpane-cloud-smoke}" E2E_NO_MATRIX=1
fi
. "$HERE/lib/common.sh"
. "$HERE/lib/cli.sh"
e2e_init SMOKE-morning
wait_start_budget 2

if [ "$LOOP" = 1 ]; then
  cli_resolve || { rec cli FAIL "could not install the runpane build under test"; exit 1; }
  if [ -n "${E2E_GOLDEN:-}" ]; then setup_src=(--golden "$E2E_GOLDEN")   # Red's path: daemon preinstalled in the golden
  else setup_src=(--no-golden ${E2E_DAEMON_DEB_URL:+--pane-deb-url "$E2E_DAEMON_DEB_URL"}); fi
  cloud_setup_from_loop_secrets "${setup_src[@]}" > "$E2E_RUN_DIR/setup.json" 2>&1 \
    || { rec setup FAIL "loop setup failed" "$E2E_RUN_DIR/setup.json"; exit 1; }
  NAMEFLAG=(--name-prefix "$E2E_PREFIX")
else
  RUNPANE_CMD=(runpane); E2E_CLI_SOURCE="PATH:$(command -v runpane)"; NAMEFLAG=()
fi
export E2E_TARGET="${E2E_TARGET:-$(rpc version 2>/dev/null | head -1)}"

# ---- 0. prerequisites
v=$(rpc version 2>&1 | head -1)
if rpc cloud list --json > "$E2E_RUN_DIR/list-before.json" 2>&1; then rec prereq PASS "runpane $v; runpane cloud is set up ($(jget 'len(d.get("hosts",[]))' < "$E2E_RUN_DIR/list-before.json") hosts)" "$E2E_RUN_DIR/list-before.json"
else rec prereq FAIL "'runpane cloud list' failed: run 'runpane cloud setup' first (runpane $v)" "$E2E_RUN_DIR/list-before.json"; exit 1; fi
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then rec tailnet-local PASS "this machine is on a tailnet"
else rec tailnet-local FAIL "this machine is not on a tailnet: 'tailscale up' first"; exit 1; fi

# ---- 1. new
LABEL="smoke-$(date +%m%d-%H%M)"; t0=$(ms_now)
rpc cloud new --label "$LABEL" --repo "$REPO" --size "$SIZE" "${NAMEFLAG[@]}" --yes --json > "$E2E_RUN_DIR/new.json" 2> "$E2E_RUN_DIR/new.progress.txt"; rc=$?
HOST=$(jget 'd["host"]["hostname"]' < "$E2E_RUN_DIR/new.json" 2>/dev/null); PAIR=$(jget 'd["pairingPath"]' < "$E2E_RUN_DIR/new.json" 2>/dev/null)
if [ $rc = 0 ] && [ -n "$HOST" ] && [ -f "$PAIR" ]; then rec new PASS "cloud new -> $HOST in $(secs_since "$t0")s ($(jget 'd["host"]["baseUrl"]' < "$E2E_RUN_DIR/new.json"))" "$E2E_RUN_DIR/new.json"
else rec new FAIL "cloud new failed (rc=$rc); see new.progress.txt" "$E2E_RUN_DIR/new.progress.txt"; exit 1; fi
destroy_host() {
  [ "$KEEP_HOST" = 1 ] && { log "--keep: leaving $HOST running (runpane cloud destroy $HOST --yes when done)"; return; }
  rpc cloud destroy "$HOST" --yes --json > "$E2E_RUN_DIR/destroy.json" 2>&1 && ! rpc cloud list --json 2>/dev/null | grep -q "\"$HOST\"" \
    && rec destroy PASS "cloud destroy removed $HOST (tailnet device, sandbox, local record)" "$E2E_RUN_DIR/destroy.json" \
    || rec destroy FAIL "destroy did not complete; run: runpane cloud destroy $HOST --yes" "$E2E_RUN_DIR/destroy.json"
}
summary() {
  echo; echo "== Runpane Cloud morning smoke: $(grep -c '"PASS"' "$E2E_RUN_DIR/results.jsonl") PASS, $(grep -c '"FAIL"' "$E2E_RUN_DIR/results.jsonl") FAIL  (evidence: $E2E_RUN_DIR)"
  ! grep -q '"FAIL"' "$E2E_RUN_DIR/results.jsonl"
}
trap 'destroy_host; summary; e2e_finish' EXIT

# ---- 2. health over the tailnet
h=$(cl remote wait-health "$PAIR" --timeout 90); printf '%s\n' "$h" > "$E2E_RUN_DIR/health.json"
[ "$(jget 'd["http"]' <<<"$h")" = 200 ] && rec health PASS "/health 200 over the tailnet, version $(jget 'd["body"].get("version")' <<<"$h"), readiness $(jget 'd["body"].get("readiness",{}).get("state")' <<<"$h")" "$E2E_RUN_DIR/health.json" \
  || { rec health FAIL "no /health from this machine; is it on the same tailnet?" "$E2E_RUN_DIR/health.json"; exit 1; }

# ---- 3. a shell Pane + submit, as a paired client (runpane --host if this build has it, else /invoke)
use_host=0; rpc --host "$PAIR" repos list --json > "$E2E_RUN_DIR/host-repos.json" 2>&1 && use_host=1
inv() { cl remote invoke "$PAIR" "$@"; }
REPO_NAME=$(jget '([r.get("name") for r in (d["body"]["result"].get("repositories") or d["body"]["result"].get("repos") or [])] or [""])[0]' <<<"$(inv runpane:repos:list '[{}]')" 2>/dev/null)
if [ -z "$REPO_NAME" ]; then
  rec repo-registered FAIL "cloud new --repo cloned the repo but did not register it with the cloud daemon (repos list is empty)"
  RDIR="/home/user/$(basename "${REPO%.git}")"
  inv runpane:repos:add "[{\"path\":\"$RDIR\",\"name\":\"$(basename "${REPO%.git}")\"}]" > "$E2E_RUN_DIR/repos-add.json"
  REPO_NAME=$(jget '([r.get("name") for r in (d["body"]["result"].get("repositories") or d["body"]["result"].get("repos") or [])] or [""])[0]' <<<"$(inv runpane:repos:list '[{}]')" 2>/dev/null)
  [ -n "$REPO_NAME" ] || { rec pane FAIL "could not register $RDIR either" "$E2E_RUN_DIR/repos-add.json"; exit 1; }
  log "registered $RDIR as '$REPO_NAME' so the rest of the smoke can run"
else rec repo-registered PASS "cloud new --repo registered '$REPO_NAME' with the cloud daemon"; fi
if [ "$use_host" = 1 ]; then
  pc=$(rpc --host "$PAIR" panes create --repo "$REPO_NAME" --name smoke --tool-command bash --title smoke-shell --source agent --no-focus --wait-ready --yes --json 2>&1)
  pc="{\"http\":200,\"body\":{\"result\":$pc}}"
else
  pc=$(inv runpane:panes:create "[{\"repo\":\"$REPO_NAME\",\"panes\":[{\"name\":\"smoke\",\"pinned\":true,\"tool\":{\"command\":\"bash\",\"title\":\"smoke-shell\"}}],\"waitReady\":true,\"noFocus\":true,\"source\":\"agent\"}]" --timeout 120)
fi
printf '%s\n' "$pc" > "$E2E_RUN_DIR/pane-create.json"
PANEL=$(jget '(d["body"]["result"].get("items") or [{}])[0].get("panelId") or ""' <<<"$pc" 2>/dev/null)
[ -n "$PANEL" ] && rec pane PASS "shell Pane created in the cloud Session (panel $PANEL, via /invoke)" "$E2E_RUN_DIR/pane-create.json" \
  || { rec pane FAIL "could not create a shell Pane" "$E2E_RUN_DIR/pane-create.json"; exit 1; }
submit_check() {  # submit_check <check> <marker>
  local out
  if [ "$use_host" = 1 ]; then out=$(rpc --host "$PAIR" panels submit --panel "$PANEL" --text "echo $2" --yes --json 2>&1)
  else out=$(inv runpane:panels:submit "[{\"panelId\":\"$PANEL\",\"input\":\"echo $2\"}]"); fi
  printf '%s\n' "$out" > "$E2E_RUN_DIR/$1.json"
  local end=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    inv runpane:panels:screen "[{\"panelId\":\"$PANEL\",\"limit\":60}]" | grep -qF "$2" && { rec "$1" PASS "submit ($([ $use_host = 1 ] && echo 'runpane --host' || echo '/invoke')) ran in the cloud shell" "$E2E_RUN_DIR/$1.json"; return 0; }
    sleep 1
  done
  rec "$1" FAIL "submitted text never showed up: $(head -c 200 <<<"$out")" "$E2E_RUN_DIR/$1.json"; return 1
}
submit_check submit "smoke-$RANDOM$RANDOM"

# ---- 4. stop -> asleep -> wake -> same panel works
t0=$(ms_now); rpc cloud stop "$HOST" --yes --json > "$E2E_RUN_DIR/stop.json" 2>&1; src=$?
st=$(rpc cloud status "$HOST" --json 2>/dev/null | jget 'd.get("status")')
[ $src = 0 ] && [ "$st" = asleep ] && rec stop PASS "cloud stop in $(secs_since "$t0")s; status=asleep" "$E2E_RUN_DIR/stop.json" || rec stop FAIL "rc=$src status=$st" "$E2E_RUN_DIR/stop.json"
t0=$(ms_now); rpc cloud wake "$HOST" --json > "$E2E_RUN_DIR/wake.json" 2>&1; wrc=$?; ws=$(secs_since "$t0")
hh=$(cl remote health "$PAIR" --timeout 5)
[ $wrc = 0 ] && [ "$(jget 'd["http"]' <<<"$hh")" = 200 ] && rec wake PASS "cloud wake in ${ws}s, /health 200 right after" "$E2E_RUN_DIR/wake.json" "seconds=$ws" \
  || rec wake FAIL "rc=$wrc health=$(jget 'd["http"]' <<<"$hh") after ${ws}s" "$E2E_RUN_DIR/wake.json"
submit_check submit-after-wake "smoke-wake-$RANDOM$RANDOM"

# ---- 5. desktop (you look; the script can't click for you)
if [ -t 0 ] && [ "$LOOP" = 0 ]; then
  echo; echo ">>> Open Pane desktop, open the host switcher in the sidebar, pick '$HOST' ($LABEL)."
  echo ">>> You should see the 'smoke' Pane with 'smoke-wake-...' in its shell. Did it connect? [y/N]"
  read -r ans; [[ "$ans" =~ ^[Yy] ]] && rec desktop PASS "Red confirmed the desktop switcher connects to $HOST" || rec desktop FAIL "desktop did not connect to $HOST"
else rec desktop SKIP "not interactive: pick '$HOST' in Pane's host switcher to check the desktop by eye"; fi

