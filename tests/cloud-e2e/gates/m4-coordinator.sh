#!/usr/bin/env bash
# M4 gate: the coordinator's always-on part (final-plan S4 M4, blocking problem 4).
#   Reconciler: with a missing, empty, or provider-failed directory it aborts and touches nothing; with a real
#   directory it only STOPS an orphan (never deletes it) and leaves listed Sessions alone.
#   Idle-stop: refuses while the Session is busy (safe-to-stop says no); stops it after consecutive safe answers.
#   Wake: status says asleep without waking; wake brings the Session back to /health readiness; HTTP API auth;
#   the runaway guard refuses too many resumes.
# The coordinator runs here from the runpane build under test (`runpane cloud coordinator ...`), against a
# Session sandbox (daemon build under test) and a bare orphan sandbox, both under a gate-only name prefix.
# Env: E2E_RUNPANE_BIN / E2E_RUNPANE_TGZ_URL, E2E_DAEMON_DEB_URL
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/provision.sh"; . "$E2E_LIB/fixtures.sh"; . "$E2E_LIB/cli.sh"
export E2E_DAEMON_DEB_URL="${E2E_DAEMON_DEB_URL-$(dist_url deb)}"
e2e_init M4-coordinator
wait_start_budget $([ "${E2E_M4_SKIP_RECONCILE:-0}" = 1 ] && echo 2 || echo 3)
cli_resolve || { rec cli BLOCKED "runpane CLI under test not installable"; exit 1; }
E2E_TARGET="${E2E_TARGET_OVERRIDE:-${E2E_CLI_SOURCE##*/}}"; export E2E_TARGET

CH="$E2E_SECRETS/coord"; CFG="$CH/config.json"; (umask 077; mkdir -p "$CH")
coord() {  # in-process (--local) for the commands that act against a coordinator; init/serve/mint-token as-is
  case "$1" in status|wake|reconcile|idle-check|alerts) rpc cloud coordinator "$@" --local --config "$CFG" ;;
    *) rpc cloud coordinator "$@" --config "$CFG" ;; esac; }
if coord help 2>&1 | grep -qiE 'not available|unknown cloud command'; then
  main=$(find "$(dirname "$(dirname "$(readlink -f "${RUNPANE_CMD[0]}")")")" -path '*coordinator/main.js' 2>/dev/null | head -1)
  [ -n "$main" ] || { rec coordinator BLOCKED "no coordinator in this runpane build ($E2E_CLI_SOURCE)"; exit 0; }
  coord() { case "$1" in status|wake|reconcile|idle-check|alerts) node "$main" "$@" --local --config "$CFG" ;; *) node "$main" "$@" --config "$CFG" ;; esac; }
fi
KEYF="$E2E_SECRETS/boat.key"
(umask 077; sed -E 's/^[^:]*:[[:space:]]*(Bearer[[:space:]]+)?//' "${CLOUDLAB_BOAT_AUTH_HEADER_FILE:-$HOME/rc-loop/secrets/boat.hdr}" | tr -d '\r\n' > "$KEYF")
PFX="$E2E_PREFIX-m4"
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
coord init --listen-host 127.0.0.1 --listen-port "$PORT" --directory-file "$CH/directory.json" --api-key-file "$KEYF" --managed-prefix "$PFX" >/dev/null \
  || { rec coordinator FAIL "coordinator init failed"; exit 1; }
python3 - "$CFG" <<'PY'
import json,sys
p=sys.argv[1]; c=json.load(open(p))
c["reconcile"]={"orphanGraceSeconds":0,"maxOrphanStopsPerRun":3}
c["idleStop"]={"requiredConsecutiveSafe":2,"wakeGraceSeconds":0}
json.dump(c,open(p,"w"),indent=1)
PY
rec coordinator-scope INFO "gate runs the coordinator with the loop's unscoped boat key; the scoped-key restriction is m4's own gate"

# ---- fixtures: one Session with a daemon, one orphan (bare sandbox, same managed prefix)
provision_manual m4-s small || exit 1
S_ID=$SB_ID; S_HOST=$SB_HOST; S_PAIR=$SB_PAIRING; S_BASE=$SB_BASE
if [ "${E2E_M4_SKIP_RECONCILE:-0}" != 1 ]; then O_ID=$(sb_create "m4-orphan-$(date -u +%H%M%S)" small) && cl boat wait "$O_ID" idle,ready,running --timeout 120 >/dev/null; fi
fx=$(fixture_shell_pane "$S_ID" m4shell | tail -1); SHELL_PANEL=$(jget 'd["panelId"]' <<<"$fx")
TOKEN_JSON=$(python3 -c 'import sys;sys.path.insert(0,sys.argv[2]);import cloudlab,json;print(json.dumps(cloudlab.read_pairing(sys.argv[1])["token"]))' "$S_PAIR" "$E2E_LIB")
write_dir() {  # write_dir <json-sessions-array>
  (umask 077; printf '{"version":1,"generatedAt":"%s","sessions":%s}\n' "$(date -u +%FT%TZ)" "$1" > "$CH/directory.json")
}
S_ENTRY="[{\"sessionId\":\"$S_HOST\",\"label\":\"$S_HOST\",\"provider\":\"boat\",\"sandboxId\":\"$S_ID\",\"baseUrl\":\"$S_BASE\",\"nodeId\":\"$SB_NODE\",\"coordinatorToken\":$TOKEN_JSON}]"
both_running() { local a b; a=$(cl boat get "$S_ID" --field state); b=$(cl boat get "$O_ID" --field state)
  [[ "$a" =~ ^(idle|ready|running)$ && "$b" =~ ^(idle|ready|running)$ ]] && echo yes || echo "no(S=$a,O=$b)"; }

if [ "${E2E_M4_SKIP_RECONCILE:-0}" != 1 ]; then
# ---- reconciler safety
rm -f "$CH/directory.json"
r=$(coord reconcile 2>>"$E2E_RUN_DIR/coord-stderr.log"); printf '%s\n' "$r" | ev reconcile-missing.json >/dev/null
[ "$(jget 'd.get("aborted")' <<<"$r" 2>/dev/null)" = directory-unreadable ] && [ "$(both_running)" = yes ] \
  && rec reconcile.missing-directory PASS "missing directory -> aborted=directory-unreadable; nothing stopped or deleted" "$E2E_RUN_DIR/reconcile-missing.json" \
  || rec reconcile.missing-directory FAIL "aborted=$(jget 'd.get("aborted")' <<<"$r" 2>/dev/null) sandboxes=$(both_running)" "$E2E_RUN_DIR/reconcile-missing.json"
write_dir '[]'
r=$(coord reconcile 2>>"$E2E_RUN_DIR/coord-stderr.log"); printf '%s\n' "$r" | ev reconcile-empty.json >/dev/null
[ "$(jget 'd.get("aborted")' <<<"$r" 2>/dev/null)" = directory-empty ] && [ "$(both_running)" = yes ] \
  && rec reconcile.empty-directory PASS "empty directory while provider lists managed sandboxes -> aborted=directory-empty; nothing touched" "$E2E_RUN_DIR/reconcile-empty.json" \
  || rec reconcile.empty-directory FAIL "aborted=$(jget 'd.get("aborted")' <<<"$r" 2>/dev/null) sandboxes=$(both_running)" "$E2E_RUN_DIR/reconcile-empty.json"
write_dir "$S_ENTRY"; cp "$KEYF" "$KEYF.good"; (umask 077; echo "boat_invalid_e2e_key" > "$KEYF")
r=$(coord reconcile 2>>"$E2E_RUN_DIR/coord-stderr.log"); printf '%s\n' "$r" | ev reconcile-provider-fail.json >/dev/null
cp "$KEYF.good" "$KEYF"
ab=$(jget 'd.get("aborted")' <<<"$r" 2>/dev/null)
[ "$(both_running)" = yes ] && { [ "$ab" = provider-error ] || [ -z "$ab" ]; } \
  && rec reconcile.provider-failure PASS "provider list fails -> aborted=${ab:-error exit}; nothing touched" "$E2E_RUN_DIR/reconcile-provider-fail.json" \
  || rec reconcile.provider-failure FAIL "aborted=$ab sandboxes=$(both_running)" "$E2E_RUN_DIR/reconcile-provider-fail.json"
r=$(coord reconcile 2>>"$E2E_RUN_DIR/coord-stderr.log"); printf '%s\n' "$r" | ev reconcile-orphan.json >/dev/null
cl boat wait "$O_ID" archived --timeout 120 >/dev/null
os=$(cl boat get "$O_ID" --field state); ss_=$(cl boat get "$S_ID" --field state)
[ "$os" = archived ] && [[ "$ss_" =~ ^(idle|ready|running)$ ]] \
  && rec reconcile.orphan-stop-only PASS "orphan $O_ID stopped (state=$os, still exists: not deleted); listed Session untouched ($ss_)" "$E2E_RUN_DIR/reconcile-orphan.json" \
  || rec reconcile.orphan-stop-only FAIL "orphan=$os session=$ss_" "$E2E_RUN_DIR/reconcile-orphan.json"

else rec reconcile SKIP "E2E_M4_SKIP_RECONCILE=1 (already gated on this head)"; fi

write_dir "$S_ENTRY"   # serve reads the directory on every pass (the reconcile section may have been skipped)

# ---- the always-on part: one `serve` process runs the idle-stop loop and the HTTP API (its streak and resume
#      counts live in that process, as in production). Short interval; runaway guard at 1 resume/hour.
python3 - "$CFG" <<'PY'
import json,sys
p=sys.argv[1]; c=json.load(open(p))
c["idleStop"]={"enabled":True,"intervalSeconds":20,"requiredConsecutiveSafe":2,"wakeGraceSeconds":600}
c["reconcile"]={"enabled":False}
c["guards"]={"maxResumesPerSandboxPerHour":1}
json.dump(c,open(p,"w"),indent=1)
PY
rp_in "$S_ID" panels submit --panel "$SHELL_PANEL" --text 'for i in $(seq 1 90); do echo busy $i; sleep 1; done' --yes --json >/dev/null
sleep 2
coord serve > "$E2E_RUN_DIR/coordinator-serve.log" 2>&1 &
SERVE=$!; register_resource pid "$SERVE" coordinator-serve; sleep 3
grep -q EADDRINUSE "$E2E_RUN_DIR/coordinator-serve.log" && { rec coordinator-serve BLOCKED "coordinator serve could not bind 127.0.0.1:$PORT"; exit 1; }
sleep 60
st=$(cl boat get "$S_ID" --field state)
[[ "$st" =~ ^(idle|ready|running)$ ]] && rec idle-stop.refuses-busy PASS "serve loop (20 s interval) left the Session running for 60 s while its shell printed ($st)" "$E2E_RUN_DIR/coordinator-serve.log" \
  || rec idle-stop.refuses-busy FAIL "Session state while busy: $st" "$E2E_RUN_DIR/coordinator-serve.log"
log "waiting for the Session to go quiet (output window 120 s) and the serve loop to stop it"
stopped=""; end=$(( $(date +%s) + 420 )); t0=$(ms_now)
while [ "$(date +%s)" -lt "$end" ]; do
  st=$(cl boat get "$S_ID" --field state); [[ "$st" =~ ^(archiving|archived)$ ]] && { stopped=1; break; }; sleep 10
done
cl boat wait "$S_ID" archived --timeout 120 >/dev/null
if [ -n "$stopped" ]; then rec idle-stop.stops-idle PASS "serve loop stopped the idle Session after consecutive safe answers ($(secs_since "$t0")s after the busy phase)" "$E2E_RUN_DIR/coordinator-serve.log" "seconds=$(secs_since "$t0")"
else rec idle-stop.stops-idle FAIL "serve loop never stopped the idle Session (state=$(cl boat get "$S_ID" --field state))" "$E2E_RUN_DIR/coordinator-serve.log"
  cl boat stop "$S_ID" >/dev/null; cl boat wait "$S_ID" archived --timeout 120 >/dev/null; fi

# ---- HTTP API: auth, status (never wakes), wake
coord mint-token user:e2e --out "$E2E_SECRETS/caller.tok" >/dev/null
AUTH=(-H @<(printf 'Authorization: Bearer %s\n' "$(cat "$E2E_SECRETS/caller.tok")"))
CURL() { curl -sS -o "$E2E_RUN_DIR/http-$1.json" -w '%{http_code}' "${@:2}"; }
a=$(CURL noauth "http://127.0.0.1:$PORT/cloud/status?host=$S_HOST")
b=$(CURL badauth -H "Authorization: Bearer rpc1.user:e2e.AAAA" "http://127.0.0.1:$PORT/cloud/status?host=$S_HOST")
c=$(CURL status -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$E2E_SECRETS/caller.tok")") "http://127.0.0.1:$PORT/cloud/status?host=$S_HOST")
hs=$(jget 'd.get("status")' < "$E2E_RUN_DIR/http-status.json" 2>/dev/null)
[ "$a" = 401 ] && [ "$b" = 403 ] && [ "$c" = 200 ] && rec http.auth PASS "/cloud/status: no token 401, bad token 403, minted caller token 200" || rec http.auth FAIL "no token $a, bad $b, good $c"
[ "$hs" = asleep ] && [ "$(cl boat get "$S_ID" --field state)" = archived ] && rec status-asleep PASS "GET /cloud/status -> asleep, and it did not wake the sandbox" "$E2E_RUN_DIR/http-status.json" \
  || rec status-asleep FAIL "status=$hs boat=$(cl boat get "$S_ID" --field state)" "$E2E_RUN_DIR/http-status.json"
t0=$(ms_now)
c=$(CURL wake -X POST -H 'Content-Type: application/json' -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$E2E_SECRETS/caller.tok")") \
  --data "{\"host\":\"$S_HOST\",\"wait\":true,\"timeoutMs\":120000}" "http://127.0.0.1:$PORT/cloud/wake"); ws=$(secs_since "$t0")
h=$(cl remote health "$S_PAIR" --timeout 5)
[ "$c" = 200 ] && [ "$(jget 'd.get("status")' < "$E2E_RUN_DIR/http-wake.json")" = awake ] && [ "$(jget 'd["http"]' <<<"$h")" = 200 ] \
  && rec wake.http PASS "POST /cloud/wake -> awake in ${ws}s, /health 200 (readiness=$(jget 'd["body"].get("readiness",{}).get("state")' <<<"$h"))" "$E2E_RUN_DIR/http-wake.json" "seconds=$ws" \
  || rec wake.http FAIL "HTTP $c status=$(jget 'd.get("status")' < "$E2E_RUN_DIR/http-wake.json" 2>/dev/null)" "$E2E_RUN_DIR/http-wake.json"

# ---- runaway guard (same serve process: 1 resume/hour already used by the wake above)
cl boat stop "$S_ID" >/dev/null; cl boat wait "$S_ID" archived --timeout 120 >/dev/null
c=$(CURL runaway -X POST -H 'Content-Type: application/json' -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$E2E_SECRETS/caller.tok")") \
  --data "{\"host\":\"$S_HOST\",\"wait\":false,\"timeoutMs\":30000}" "http://127.0.0.1:$PORT/cloud/wake")
sleep 5; gs=$(cl boat get "$S_ID" --field state)
grep -qE 'runaway|wake-rate-limited' "$E2E_RUN_DIR/http-runaway.json" && [ "$gs" = archived ] \
  && rec runaway-guard PASS "2nd wake within the hour refused (HTTP $c, $(jget 'd.get("code")' < "$E2E_RUN_DIR/http-runaway.json")); sandbox stayed asleep" "$E2E_RUN_DIR/http-runaway.json" \
  || rec runaway-guard FAIL "guard did not refuse (HTTP $c, sandbox $gs)" "$E2E_RUN_DIR/http-runaway.json"
kill "$SERVE" 2>/dev/null; wait "$SERVE" 2>/dev/null
