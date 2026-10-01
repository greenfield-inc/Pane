#!/usr/bin/env bash
# M0 facts + harness proof. Builds one cloud Session by hand (provider + Tailscale APIs + the
# published daemon installer), then re-proves the M0 facts the later gates rely on:
#   tailnet tag + no Tailscale SSH, /health over the tailnet, bearer auth on /invoke,
#   panels submit over /invoke, stop/resume keeps the tailnet identity, wake time,
#   the state of `panels submit` after resume (XFAIL on upstream, PASS once M2 lands),
#   and clean teardown (device gone, sandbox gone).
# Env: E2E_SIZE (default|small|large, default: default), E2E_DAEMON_DEB_URL / E2E_RUNPANE_TGZ_URL (see lib/provision.sh)
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/provision.sh"
. "$E2E_LIB/fixtures.sh"
E2E_TARGET="${E2E_TARGET:-${E2E_DAEMON_DEB_URL:+fork-deb}}"; E2E_TARGET="${E2E_TARGET:-runpane@latest}"
e2e_init M0-harness
wait_start_budget 2
G=M0

provision_manual m0 "${E2E_SIZE:-default}" || exit 1

# --- tailnet identity: tag:rp-session, Tailscale SSH off
dev=$(cl ts find "$SB_HOST"); printf '%s\n' "$dev" | ev tailnet-device.json >/dev/null
tags=$(jget 'd[0]["tags"] if d else None' <<<"$dev")
prefs=$(sbx "$SB_ID" 60 <<'SH'
tailscale debug prefs 2>/dev/null | python3 -c "import json,sys;p=json.load(sys.stdin);print(json.dumps({'RunSSH':p.get('RunSSH'),'Hostname':p.get('Hostname'),'AdvertiseTags':p.get('AdvertiseTags')}))"
SH
)
printf '%s\n' "$prefs" | ev tailnet-prefs.json >/dev/null
if [ "$tags" = '["tag:rp-session"]' ] && [ "$(jget 'd["RunSSH"]' <<<"$prefs")" = false ]; then
  rec tailnet-tag-nossh PASS "device $SB_NODE tags=$tags RunSSH=false" "$E2E_RUN_DIR/tailnet-prefs.json"
else
  rec tailnet-tag-nossh FAIL "tags=$tags prefs=$prefs" "$E2E_RUN_DIR/tailnet-prefs.json"
fi

# --- /health over the tailnet (first Serve cert can take ~35 s)
h=$(cl remote wait-health "$SB_PAIRING" --timeout 120); printf '%s\n' "$h" | ev health-initial.json >/dev/null
if [ "$(jget 'd["http"]' <<<"$h")" = 200 ]; then
  rec health-tailnet PASS "GET $SB_BASE/health 200 after $(jget 'd["seconds"]' <<<"$h")s body=$(jget 'd["body"]' <<<"$h")" "$E2E_RUN_DIR/health-initial.json" "seconds=$(jget 'd["seconds"]' <<<"$h")"
else
  rec health-tailnet FAIL "no 200 from $SB_BASE/health: $h" "$E2E_RUN_DIR/health-initial.json"; exit 1
fi

# --- bearer auth on /invoke
noauth=$(cl remote invoke "$SB_PAIRING" runpane:repos:list '[{}]' --no-token); auth=$(cl remote invoke "$SB_PAIRING" runpane:repos:list '[{}]')
printf '%s\n%s\n' "$noauth" "$auth" | ev invoke-auth.json >/dev/null
na=$(jget 'd["http"]' <<<"$noauth"); wa=$(jget 'd["http"]' <<<"$auth")
if [ "$na" = 401 ] && [ "$wa" = 200 ]; then rec invoke-auth PASS "/invoke without token $na, with pairing token $wa" "$E2E_RUN_DIR/invoke-auth.json"
else rec invoke-auth FAIL "/invoke without token $na, with token $wa" "$E2E_RUN_DIR/invoke-auth.json"; fi

# --- a shell Pane, submit over /invoke as a paired user client, read it back
fx=$(fixture_shell_pane "$SB_ID" m0shell | tail -1); printf '%s\n' "$fx" | ev fixture-pane.json >/dev/null
PANEL=$(jget 'd["panelId"]' <<<"$fx")
if [ -z "$PANEL" ] || [ "$PANEL" = None ]; then rec panel-submit FAIL "fixture pane not created: $fx" "$E2E_RUN_DIR/fixture-pane.json"; exit 1; fi
marker="e2e-m0-$RANDOM$RANDOM"
s1=$(cl remote invoke "$SB_PAIRING" runpane:panels:submit "[{\"panelId\":\"$PANEL\",\"input\":\"echo $marker > /home/user/rcl/marker-1.txt; echo $marker\"}]")
sleep 2
scr=$(cl remote invoke "$SB_PAIRING" runpane:panels:screen "[{\"panelId\":\"$PANEL\",\"limit\":40}]")
printf '%s\n%s\n' "$s1" "$scr" | ev submit-before.json >/dev/null
if grep -q "$marker" <<<"$scr"; then rec panel-submit PASS "submit over tailnet /invoke to panel $PANEL; marker on screen" "$E2E_RUN_DIR/submit-before.json"
else rec panel-submit FAIL "marker not on screen after submit" "$E2E_RUN_DIR/submit-before.json"; fi

# --- stop / resume: identity survives, wake time
node_before=$(cl ts find "$SB_HOST" | jget '[(x["nodeId"], x["name"], x["addresses"]) for x in d]')
t0=$(ms_now); st=$(cl boat stop "$SB_ID"); arch=$(cl boat wait "$SB_ID" archived --timeout 180)
stop_s=$(secs_since "$t0")
printf '%s\n%s\n' "$st" "$arch" | ev stop.json >/dev/null
[ "$(jget 'd["state"]' <<<"$arch")" = archived ] || { rec stop FAIL "never archived: $arch" "$E2E_RUN_DIR/stop.json"; exit 1; }
rec stop PASS "stop -> archived in ${stop_s}s" "$E2E_RUN_DIR/stop.json" "seconds=$stop_s"
down=$(cl remote health "$SB_PAIRING" --timeout 5); rec asleep-health-down INFO "health while archived: http=$(jget 'd["http"]' <<<"$down")"
t0=$(ms_now); rs=$(cl boat resume "$SB_ID")
wh=$(cl remote wait-health "$SB_PAIRING" --timeout 180 --interval 0.5); wake_s=$(secs_since "$t0")
printf '%s\n%s\n' "$rs" "$wh" | ev resume.json >/dev/null
if [ "$(jget 'd["http"]' <<<"$wh")" = 200 ]; then rec wake-health PASS "resume call -> tailnet /health 200 in ${wake_s}s (M0 budget 9-12s)" "$E2E_RUN_DIR/resume.json" "seconds=$wake_s"
else rec wake-health FAIL "no /health after resume within 180s" "$E2E_RUN_DIR/resume.json"; fi
node_after=$(cl ts find "$SB_HOST" | jget '[(x["nodeId"], x["name"], x["addresses"]) for x in d]')
printf 'before %s\nafter  %s\n' "$node_before" "$node_after" | ev identity.txt >/dev/null
if [ "$node_before" = "$node_after" ]; then rec identity-survives PASS "nodeId/name/IPs identical across stop/resume" "$E2E_RUN_DIR/identity.txt"
else rec identity-survives FAIL "tailnet identity changed" "$E2E_RUN_DIR/identity.txt"; fi
m=$(sbx "$SB_ID" 30 <<<'cat /home/user/rcl/marker-1.txt 2>/dev/null')
[ "$m" = "$marker" ] && rec data-survives PASS "file written before stop survives resume" || rec data-survives FAIL "marker file content after resume: '$m'"

# --- panels submit to the SAME panel after resume (the M2 gate; upstream fails with 'not initialized')
s2=$(cl remote invoke "$SB_PAIRING" runpane:panels:submit "[{\"panelId\":\"$PANEL\",\"input\":\"echo after-resume-$marker\"}]")
printf '%s\n' "$s2" | ev submit-after-resume.json >/dev/null
if [ "$(jget 'd["http"]' <<<"$s2")" = 200 ]; then
  rec post-resume-submit PASS "same panel accepted submit after boat power-off/resume" "$E2E_RUN_DIR/submit-after-resume.json"
elif grep -q 'not initialized' <<<"$s2"; then
  rec post-resume-submit XFAIL "'not initialized' after resume: known upstream gap, M2 fixes it" "$E2E_RUN_DIR/submit-after-resume.json"
else
  rec post-resume-submit FAIL "unexpected: $(head -c 300 <<<"$s2")" "$E2E_RUN_DIR/submit-after-resume.json"
fi

# --- teardown, verified through the oracle (tailnet device first, then sandbox)
if [ "${KEEP:-0}" != 1 ]; then
  cl ts delete "$SB_NODE" >/dev/null; cl boat delete "$SB_ID" >/dev/null
  sleep 3
  gone_sb=$(cl boat get "$SB_ID" --field state); gone_dev=$(cl ts find "$SB_HOST" | jget 'len(d)')
  if { [ "$gone_sb" = gone ] || [ "$gone_sb" = archiving ]; } && [ "$gone_dev" = 0 ]; then rec teardown PASS "sandbox state=$gone_sb, tailnet devices named $SB_HOST: $gone_dev"
  else rec teardown FAIL "sandbox state=$gone_sb, devices=$gone_dev"; fi
fi
