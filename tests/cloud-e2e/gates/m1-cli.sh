#!/usr/bin/env bash
# M1 gate: `runpane cloud` CLI end to end on boat (final-plan S4 M1).
#   setup -> new (sandbox + tailnet + daemon + pairing + desktop profile) -> stop/wake x N keeps identity
#   -> destroy removes device and sandbox. Everything is driven by the CLI; boat/Tailscale APIs are the oracle.
# Env: E2E_CYCLES (3), E2E_SIZE (default), E2E_REPO (small public repo), E2E_RUNPANE_BIN / E2E_RUNPANE_TGZ_URL,
#      E2E_DAEMON_DEB_URL (default: dist-current .deb), E2E_GOLDEN (default: dist-current golden, else --no-golden)
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/cli.sh"
e2e_init M1-cli
wait_start_budget $((1 + ${E2E_CYCLES:-3}))
CYCLES="${E2E_CYCLES:-3}"; REPO="${E2E_REPO:-https://github.com/octocat/Hello-World.git}"

cli_resolve || { rec cli BLOCKED "runpane CLI under test not installable"; exit 1; }
E2E_TARGET="${E2E_TARGET_OVERRIDE:-$E2E_CLI_SOURCE}"; export E2E_TARGET
if ! rpc cloud --help >/dev/null 2>&1 && ! rpc help cloud 2>/dev/null | grep -q 'cloud new'; then
  rec cli BLOCKED "this runpane build has no 'cloud' command ($E2E_CLI_SOURCE)"; exit 0
fi

GOLDEN="${E2E_GOLDEN:-$(dist_url golden)}"
# with a golden image the daemon is preinstalled; only pass a .deb when asked explicitly
if [ -n "$GOLDEN" ]; then DEB="${E2E_DAEMON_DEB_URL:-}"; else DEB="${E2E_DAEMON_DEB_URL:-$(dist_url deb)}"; fi
setup_flags=(); [ -n "$DEB" ] && setup_flags+=(--pane-deb-url "$DEB")
if [ -n "$GOLDEN" ]; then setup_flags+=(--golden "$GOLDEN"); else setup_flags+=(--no-golden); fi
out=$(cloud_setup_from_loop_secrets "${setup_flags[@]}" 2>&1); rc=$?
printf '%s\n' "$out" | ev setup.json >/dev/null
perm=$(stat -c '%a' "$RUNPANE_CLOUD_DIR"); loose=$(find "$RUNPANE_CLOUD_DIR" -type f -perm /077 | wc -l)
if [ $rc = 0 ] && [ "$perm" = 700 ] && [ "$loose" = 0 ]; then rec setup PASS "cloud setup ok; dir 0700, no group/world-readable files; deb=${DEB:-none} golden=${GOLDEN:-none}" "$E2E_RUN_DIR/setup.json"
else rec setup FAIL "rc=$rc dir=$perm looseFiles=$loose" "$E2E_RUN_DIR/setup.json"; exit 1; fi

# ---- new
t0=$(ms_now)
out=$(rpc cloud new --label "e2e-m1-$(date +%H%M%S)" --repo "$REPO" --size "${E2E_SIZE:-default}" --yes --json 2>"$E2E_RUN_DIR/new.stderr"); rc=$?
new_s=$(secs_since "$t0"); printf '%s\n' "$out" | ev new.json >/dev/null
rec_file=$(ls -t "$RUNPANE_CLOUD_DIR"/hosts/*.json 2>/dev/null | grep -v pairing | head -1)
if [ -z "$rec_file" ]; then rec new FAIL "rc=$rc, no host record written after ${new_s}s" "$E2E_RUN_DIR/new.stderr"; exit 1; fi
HOST=$(jget 'd["profile"]["cloud"]["hostname"]' < "$rec_file")
SID=$(jget 'd["profile"]["cloud"]["sandboxId"]' < "$rec_file")
NODE=$(jget 'd["profile"]["cloud"]["nodeId"]' < "$rec_file")
PAIR=$(jget 'd["meta"].get("pairingPath") or ""' < "$rec_file")
register_resource sandbox "$SID" "$HOST"; [ -n "$NODE" ] && register_resource tsnode "$NODE" "$HOST"
[ -f "$HOME/rc-loop/sandboxes.txt" ] && echo "$SID $HOST e2e-gates(cli)" >> "$HOME/rc-loop/sandboxes.txt"
python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d['profile']['token']='<redacted>';print(json.dumps(d,indent=1))" "$rec_file" | ev host-record.json >/dev/null
if [ $rc = 0 ]; then rec new PASS "cloud new -> $HOST ($SID) in ${new_s}s" "$E2E_RUN_DIR/new.json" "seconds=$new_s"
else rec new FAIL "rc=$rc after ${new_s}s (host record exists: $HOST)" "$E2E_RUN_DIR/new.stderr"; fi

# ---- oracle: sandbox, tailnet device, Tailscale SSH off
sb=$(cl boat get "$SID"); printf '%s\n' "$sb" | ev sandbox.json >/dev/null
[ "$(jget 'd.get("name")' <<<"$sb")" = "$HOST" ] && [[ "$(jget 'd.get("state")' <<<"$sb")" =~ ^(idle|ready|running)$ ]] \
  && rec sandbox-exists PASS "boat: $SID name=$HOST state=$(jget 'd.get("state")' <<<"$sb")" "$E2E_RUN_DIR/sandbox.json" \
  || rec sandbox-exists FAIL "boat says $(head -c 300 <<<"$sb")" "$E2E_RUN_DIR/sandbox.json"
dev=$(cl ts find "$HOST"); printf '%s\n' "$dev" | ev tailnet-device.json >/dev/null
nd=$(jget 'len(d)' <<<"$dev"); tags=$(jget 'd[0]["tags"] if d else None' <<<"$dev"); dnode=$(jget 'd[0]["nodeId"] if d else ""' <<<"$dev")
runssh=$(sbx "$SID" 60 <<<'tailscale debug prefs 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get(\"RunSSH\"))"')
if [ "$nd" = 1 ] && [ "$tags" = '["tag:rp-session"]' ] && [ "$dnode" = "$NODE" ] && [ "$runssh" = False ]; then
  rec tailnet PASS "one device $NODE, tags=$tags, RunSSH=False, nodeId matches the profile" "$E2E_RUN_DIR/tailnet-device.json"
else rec tailnet FAIL "devices=$nd tags=$tags node=$dnode (profile $NODE) RunSSH=$runssh" "$E2E_RUN_DIR/tailnet-device.json"; fi

# ---- pairing + health + a paired client can use it (what the desktop does)
if [ -n "$PAIR" ] && [ -f "$PAIR" ]; then
  pm=$(cl remote pairing-mode "$PAIR"); printf '%s\n' "$pm" | ev pairing.json >/dev/null
  [ "$(jget 'd["mode"]' <<<"$pm")" = 0o600 ] && rec pairing-file PASS "pairing file 0600, baseUrl=$(jget 'd["baseUrl"]' <<<"$pm")" "$E2E_RUN_DIR/pairing.json" \
    || rec pairing-file FAIL "pairing file mode $(jget 'd["mode"]' <<<"$pm")" "$E2E_RUN_DIR/pairing.json"
else rec pairing-file FAIL "no pairing file at '$PAIR'"; exit 1; fi
if [ -n "$(sbx "$SID" 30 <<<'grep -rlE "pane-remote://[A-Za-z0-9_-]{20,}" /home/user/.bash_history /var/log/syslog 2>/dev/null | head -1')" ]; then
  rec pairing-not-logged FAIL "pairing code found in sandbox shell history/syslog"; else rec pairing-not-logged PASS "no pairing code in sandbox history/syslog"; fi
h=$(cl remote wait-health "$PAIR" --timeout 60); printf '%s\n' "$h" | ev health.json >/dev/null
ver=$(jget 'd["body"].get("version") if isinstance(d["body"],dict) else None' <<<"$h")
[ "$(jget 'd["http"]' <<<"$h")" = 200 ] && rec health PASS "tailnet /health 200 version=$ver readiness=$(jget 'd["body"].get("readiness",{}).get("state")' <<<"$h")" "$E2E_RUN_DIR/health.json" \
  || { rec health FAIL "no /health 200 over the tailnet" "$E2E_RUN_DIR/health.json"; }
inv=$(cl remote invoke "$PAIR" runpane:repos:list '[{}]'); printf '%s\n' "$inv" | ev invoke.json >/dev/null
[ "$(jget 'd["http"]' <<<"$inv")" = 200 ] && rec paired-client PASS "paired client /invoke runpane:repos:list 200 (repos: $(jget '[r.get("name") for r in (d["body"]["result"].get("repositories") or d["body"]["result"].get("repos") or [])] if isinstance(d["body"].get("result"),dict) else d["body"].get("result")' <<<"$inv"))" "$E2E_RUN_DIR/invoke.json" \
  || rec paired-client FAIL "invoke failed: $(head -c 300 <<<"$inv")" "$E2E_RUN_DIR/invoke.json"
rn=$(cl remote invoke "$PAIR" runpane:repos:list '[{}]' | jget '[r.get("name") for r in (d["body"]["result"].get("repositories") or d["body"]["result"].get("repos") or [])]' 2>/dev/null)
want=$(basename "${REPO%.git}")
grep -q "\"$want\"" <<<"$rn" && rec repo-registered PASS "cloud new --repo registered '$want' with the cloud daemon (repos: $rn)" \
  || rec repo-registered FAIL "cloud new --repo cloned but did not register '$want' with the cloud daemon (repos: $rn)"
desk="$RUNPANE_CLOUD_DESKTOP_DIR/config.json"
if [ -f "$desk" ] && python3 - "$desk" "$HOST" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); profs=(((d.get('remoteDaemon') or {}).get('client') or {}).get('profiles') or [])
ok=[p for p in profs if (p.get('cloud') or {}).get('hostname')==sys.argv[2] and p.get('transport')=='http+sse' and p.get('token')]
sys.exit(0 if ok else 1)
PY
then rec desktop-profile PASS "desktop profile store has a cloud profile for $HOST (the #853 switcher reads this store)"
else rec desktop-profile FAIL "no cloud profile for $HOST in $desk"; fi
rec desktop-switcher-ui INFO "desktop UI connect is manual: morning-smoke.sh prints the steps for Red"
creds=$(sbx "$SID" 60 <<'SH'
for p in ~/.claude/.credentials.json ~/.config/gh/hosts.yml ~/.git-credentials ~/.npmrc ~/.docker/config.json ~/.ssh/id_rsa ~/.ssh/id_ed25519 ~/.bash_history; do [ -e "$p" ] && echo "$p"; done
git config --global --get-all credential.helper 2>/dev/null
SH
)
[ -z "$creds" ] && rec no-credentials PASS "none of the strip-list credential files exist in the new sandbox" || rec no-credentials FAIL "present: $creds"

# ---- stop / wake cycles
st=$(rpc cloud status "$HOST" --json 2>&1); printf '%s\n' "$st" | ev status-awake.json >/dev/null
[ "$(jget 'd.get("state") or d.get("status")' <<<"$st")" = awake ] && rec status-awake PASS "cloud status: awake" "$E2E_RUN_DIR/status-awake.json" \
  || rec status-awake FAIL "cloud status said: $(head -c 200 <<<"$st")" "$E2E_RUN_DIR/status-awake.json"
for c in $(seq 1 "$CYCLES"); do
  t0=$(ms_now); so=$(rpc cloud stop "$HOST" --yes --json 2>&1); src=$?; stop_s=$(secs_since "$t0")
  arch=$(cl boat wait "$SID" archived --timeout 120)
  printf '%s\n%s\n' "$so" "$arch" | ev "cycle$c-stop.json" >/dev/null
  down=$(cl remote health "$PAIR" --timeout 4 | jget 'd["http"]')
  sst=$(rpc cloud status "$HOST" --json 2>&1 | jget 'd.get("state") or d.get("status")' 2>/dev/null)
  if [ $src = 0 ] && [ "$(jget 'd["state"]' <<<"$arch")" = archived ] && [ "$down" != 200 ] && [ "$sst" = asleep ]; then
    rec "cycle$c-stop" PASS "cloud stop ${stop_s}s; boat archived; /health unreachable; status=asleep" "$E2E_RUN_DIR/cycle$c-stop.json" "seconds=$stop_s"
  else rec "cycle$c-stop" FAIL "rc=$src boat=$(jget 'd["state"]' <<<"$arch") health=$down status=$sst" "$E2E_RUN_DIR/cycle$c-stop.json"; fi
  t0=$(ms_now); wo=$(rpc cloud wake "$HOST" --json 2>&1); wrc=$?; wake_s=$(secs_since "$t0")
  hh=$(cl remote health "$PAIR" --timeout 5)   # immediately: wake must only return once /health is ready
  printf '%s\n%s\n' "$wo" "$hh" | ev "cycle$c-wake.json" >/dev/null
  node_now=$(cl ts find "$HOST" | jget '",".join(x["nodeId"] for x in d)')
  inv=$(cl remote invoke "$PAIR" runpane:repos:list '[{}]' | jget 'd["http"]')
  rstate=$(jget 'd["body"].get("readiness",{}).get("state","n/a") if isinstance(d["body"],dict) else "n/a"' <<<"$hh")
  if [ $wrc = 0 ] && [ "$(jget 'd["http"]' <<<"$hh")" = 200 ] && [ "$rstate" != starting ] && [ "$node_now" = "$NODE" ] && [ "$inv" = 200 ]; then
    rec "cycle$c-wake" PASS "cloud wake returned in ${wake_s}s with /health 200 (readiness=$rstate); same tailnet node $NODE; old pairing token works" "$E2E_RUN_DIR/cycle$c-wake.json" "seconds=$wake_s"
  else rec "cycle$c-wake" FAIL "rc=$wrc ${wake_s}s health=$(jget 'd["http"]' <<<"$hh") readiness=$rstate node=$node_now (want $NODE) invoke=$inv" "$E2E_RUN_DIR/cycle$c-wake.json"; fi
done

# ---- destroy: tailnet device first, then sandbox; local records cleaned
if [ "${KEEP:-0}" != 1 ]; then
  t0=$(ms_now); do_=$(rpc cloud destroy "$HOST" --yes --json 2>&1); drc=$?; printf '%s\n' "$do_" | ev destroy.json >/dev/null
  sleep 3
  sbs=$(cl boat get "$SID" --field state); nd=$(cl ts find "$HOST" | jget 'len(d)')
  if [ $drc = 0 ] && { [ "$sbs" = gone ] || [ "$sbs" = archiving ]; } && [ "$nd" = 0 ]; then
    rec destroy PASS "cloud destroy in $(secs_since "$t0")s: sandbox=$sbs, tailnet devices=$nd, host record $( [ -f "$rec_file" ] && echo kept || echo removed)" "$E2E_RUN_DIR/destroy.json"
  else rec destroy FAIL "rc=$drc sandbox=$sbs devices=$nd" "$E2E_RUN_DIR/destroy.json"; fi
fi
