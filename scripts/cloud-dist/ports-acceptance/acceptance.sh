#!/bin/bash
# Session ports acceptance on a released build (Phase 5, docs/RUNPANE_CLOUD.md "Session ports").
# Independent of the ports implementation: drives only the released CLI (laptop side), the Session's
# own `runpane port`, Tailscale and plain HTTPS from a tailnet device. Evidence goes to $EV.
#
# usage: acceptance.sh <step> [args]
#   setup                      install the release CLI ($PV_TAG) and an isolated cloud config
#   new                        fresh Session from the manifest fixture (1 boat start, 1 cert)
#   c1 | c2 | c3-restart | c3-wake | c4 | c5 | c6    the checks (see README.md)
#   destroy                    destroy the Session and its tailnet device
# env (see env.example): PV_TAG, PV_ROOT, EV, PV_BOAT_ORG, PV_TS_CLIENT_ID, PV_TS_SECRET_FILE,
#   PV_BOAT_KEY_FILE, PV_GOLDEN, PV_EXEC (a command "run this script in sandbox <id>"),
#   PV_SECOND_HOST / PV_SECOND_SANDBOX / PV_SECOND_CLI (the second Session for c2), PV_GROUP_FILE (c6).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${PV_TAG:?set PV_TAG to the release tag, e.g. rc-2dbf5f03}"
: "${PV_ROOT:=$HOME/rc-loop/secrets/p5-verify}"
: "${EV:=$HOME/rc-loop/evidence/p5-verify}"
: "${PV_EXEC:=$HOME/rc-loop/bin/exec.sh}"
: "${PV_REPO:=https://github.com/jamari-morrison/Pane.git}"
: "${PV_REF:=rc-fixtures/p5-ports-manifest}"
: "${PV_SESSION_REPO:=/home/user/Pane}"
export RUNPANE_CLOUD_DIR="$PV_ROOT/cloud" RUNPANE_CLOUD_DESKTOP_DIR="$PV_ROOT/desktop"
CLIDIR="$HOME/.cache/rc-loop-p5-verify/cli-${PV_TAG#rc-}"
RUN="$EV/run.env"
mkdir -p "$EV"; umask 077
[ -f "$RUN" ] && . "$RUN"

rpv() { env -u PANE_SESSION_ID -u PANE_PANEL_ID -u PANE_ORCHESTRATION_SESSION_ID -u RUNPANE_HOST node "$CLIDIR/node_modules/runpane/dist/cli.js" "$@"; }
ts() { date -u +%H:%M:%SZ; }
log() { echo "$(ts) $*" | tee -a "$EV/timeline.txt"; }
probe() { node "$HERE/probe.mjs" "$@"; }
# The second Session's CLI (e.g. the owner's own `rpc`) must not inherit this run's isolated config dirs.
second() { env -u RUNPANE_CLOUD_DIR -u RUNPANE_CLOUD_DESKTOP_DIR ${PV_SECOND_CLI:-false} "$@"; }
# sx <sandbox> <script> [args...]: run a session/ script in a sandbox with arguments.
sx() {
  local sb="$1" script="$2"; shift 2
  local tmp; tmp=$(mktemp "${TMPDIR:-/tmp}/pa-XXXXXX.sh")
  { printf 'set --'; printf " %q" "$@"; printf '\n'; cat "$HERE/session/$script"; } > "$tmp"
  "$PV_EXEC" "$sb" "$tmp" "${SX_TIMEOUT:-600}"; local rc=$?; rm -f "$tmp"; return $rc
}
save() { printf '%s=%q\n' "$1" "$2" >> "$RUN"; eval "$1=\$2"; }
verdict() { # verdict <check> <PASS|FAIL> <text>
  echo "$(ts) $1 $2 $3" | tee -a "$EV/verdicts.txt"
}
urls_of() { rpv cloud port list "$HOST" --json | python3 -c "import json,sys;d=json.load(sys.stdin);print(' '.join(p['url'] for p in d['ports'] if p['name'] in sys.argv[1:]))" "$@"; }

step="${1:-}"; shift || true
case "$step" in
setup)
  mkdir -p "$CLIDIR" "$PV_ROOT/cloud" "$PV_ROOT/desktop"
  TGZ=$(gh release view "$PV_TAG" -R jamari-morrison/Pane --json assets --jq '.assets[].url' | grep '\.tgz$')
  DEB=$(gh release view "$PV_TAG" -R jamari-morrison/Pane --json assets --jq '.assets[].url' | grep '_amd64\.deb$')
  [ -x "$CLIDIR/node_modules/.bin/runpane" ] || (cd "$CLIDIR" && npm init -y >/dev/null && npm i --no-audit --no-fund "$TGZ" > npm.log 2>&1)
  { echo "TAG=$PV_TAG"; echo "TGZ=$TGZ"; echo "DEB=$DEB"; rpv version | head -2; } | tee "$EV/release.txt"
  rpv cloud setup --boat-key-file "$PV_BOAT_KEY_FILE" \
    --tailscale-client-id "$PV_TS_CLIENT_ID" --tailscale-secret-file "$PV_TS_SECRET_FILE" \
    --name-prefix rp-loop-p5verify --boat-org "$PV_BOAT_ORG" --no-coordinator \
    --golden "$PV_GOLDEN" --size default --transport auto --json > "$EV/setup.json" 2>&1
  echo "setup exit $?"; python3 -c "import json;d=json.load(open('$EV/setup.json'));print(d.get('checks'), d.get('settings',{}).get('boatOrg'))"
  ;;
new)
  DEB=$(sed -n 's/^DEB=//p' "$EV/release.txt")
  BOAT_ORG="$PV_BOAT_ORG" "$HOME/rc-loop/bin/starts-left.sh" 20 || { echo "start budget says no"; exit 4; }
  log "new: cloud new --repo $PV_REPO --ref $PV_REF"
  t0=$(date +%s)
  rpv cloud new --label p5verify-a --repo "$PV_REPO" --ref "$PV_REF" --pane-deb-url "$DEB" --yes --json > "$EV/new.json" 2> "$EV/new.log"
  rc=$?; log "new exit $rc after $(( $(date +%s) - t0 )) s"; cat "$EV/new.log"
  eval "$(python3 - "$EV/new.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); h=d['host']
from urllib.parse import urlparse
print(f"HOST={h['hostname']}; SB={h['sandboxId']}; DNS={urlparse(h['baseUrl']).hostname}; NODE={h['nodeId']}; TRANSPORT={h['transport']}")
PY
)"
  save HOST "$HOST"; save SB "$SB"; save DNS "$DNS"; save NODE "$NODE"; save TRANSPORT "$TRANSPORT"; save NEW_DONE "$(date +%s)"
  printf '%s %s %s\n' "$SB" "$HOST" "p5-verify $(date -u +%FT%TZ)" >> "$HOME/rc-loop/sandboxes.txt"
  printf '%s %s %s\n' "$NODE" "$HOST" "$SB" >> "$HOME/rc-loop/tailnet-nodes.txt"
  log "HOST=$HOST SB=$SB DNS=$DNS NODE=$NODE"
  ;;
c1)
  # DEFAULT PATH: the manifest's ports were published at boot with no action; list shows https; 200 + valid cert.
  log "c1: start the fixture's services (the manifest declares demo 8787 and docs 3000->8788)"
  sx "$SB" svc.sh "$HOST" 8787 3000 | tee "$EV/c1-svc.txt"
  rpv cloud port list "$HOST" --json > "$EV/c1-port-list.json" 2>&1
  rpv cloud port list "$HOST" > "$EV/c1-port-list.txt" 2>&1
  cat "$EV/c1-port-list.txt"
  probe --timeout 15000 $(python3 -c "import json;print(' '.join(p['url'] for p in json.load(open('$EV/c1-port-list.json'))['ports']))") | tee "$EV/c1-probe.jsonl"
  sx "$SB" state.sh c1 > "$EV/c1-session-state.txt"
  python3 "$HERE/judge.py" c1 "$EV" "$HOST" | tee -a "$EV/verdicts.txt"
  ;;
c2)
  # CLASH: the same service port on two Sessions at once + two ports on one Session.
  P="${1:-8790}"
  : "${PV_SECOND_HOST:?}" "${PV_SECOND_SANDBOX:?}"
  log "c2: port $P on $HOST and on $PV_SECOND_HOST"
  sx "$SB" svc.sh "$HOST" "$P" | tee "$EV/c2-svc-a.txt"
  sx "$PV_SECOND_SANDBOX" svc.sh "$PV_SECOND_HOST" "$P" | tee "$EV/c2-svc-b.txt"
  rpv cloud port open "$HOST" "$P" --name pa-clash --json > "$EV/c2-open-a.json" 2>&1; cat "$EV/c2-open-a.json"
  second cloud port open "$PV_SECOND_HOST" "$P" --name p5verify-clash --json > "$EV/c2-open-b.json" 2>&1; cat "$EV/c2-open-b.json"
  A=$(python3 -c "import json;print(json.load(open('$EV/c2-open-a.json'))['port']['url'])")
  B=$(python3 -c "import json;print(json.load(open('$EV/c2-open-b.json'))['port']['url'])")
  rpv cloud port list "$HOST" --json > "$EV/c2-port-list-a.json"
  second cloud port list "$PV_SECOND_HOST" --json > "$EV/c2-port-list-b.json"
  # Interleaved: both URLs 5 times each, plus every other port of both Sessions (no interference).
  OTHER_A=$(python3 -c "import json;print(' '.join(p['url'] for p in json.load(open('$EV/c2-port-list-a.json'))['ports'] if p['port']!=$P))")
  OTHER_B=$(python3 -c "import json;print(' '.join(p['url'] for p in json.load(open('$EV/c2-port-list-b.json'))['ports'] if p['port']!=$P))")
  for i in 1 2 3 4 5; do probe "$A" "$B"; done > "$EV/c2-probe.jsonl"
  probe $OTHER_A $OTHER_B >> "$EV/c2-probe.jsonl"
  cat "$EV/c2-probe.jsonl" | cut -c1-400
  python3 "$HERE/judge.py" c2 "$EV" "$HOST" "$PV_SECOND_HOST" "$P" | tee -a "$EV/verdicts.txt"
  if [ "${PV_KEEP_CLASH:-0}" != 1 ]; then
    second cloud port close "$PV_SECOND_HOST" p5verify-clash --json > "$EV/c2-close-b.json" 2>&1
    sx "$PV_SECOND_SANDBOX" svc.sh --stop "$P"
    probe --timeout 5000 "$B" > "$EV/c2-after-close-b.jsonl"; cat "$EV/c2-after-close-b.jsonl"
    second cloud port list "$PV_SECOND_HOST" --json > "$EV/c2-port-list-b-after.json"
  fi
  ;;
c3-restart)
  # Daemon restart (plain), then a restart after Serve lost the entries (boot reconcile must re-apply).
  U=$(rpv cloud port list "$HOST" --json | python3 -c "import json,sys;print(' '.join(p['url'] for p in json.load(sys.stdin)['ports'] if p['status']=='serving'))")
  log "c3-restart: plain daemon restart; urls: $U"
  sx "$SB" daemon-restart.sh $U | tee "$EV/c3-daemon-restart.txt"
  log "c3-restart: Serve entries dropped + daemon restart"
  sx "$SB" daemon-restart.sh --drop $U | tee "$EV/c3-daemon-restart-drop.txt"
  probe $U | tee "$EV/c3-restart-probe.jsonl"
  ;;
c3-wake)
  U=$(rpv cloud port list "$HOST" --json | python3 -c "import json,sys;print(' '.join(p['url'] for p in json.load(sys.stdin)['ports'] if p['status']=='serving'))")
  sx "$SB" state.sh before-stop > "$EV/c3-before-stop.txt"
  BOAT_ORG="$PV_BOAT_ORG" "$HOME/rc-loop/bin/starts-left.sh" 20 || { echo "start budget says no"; exit 4; }
  log "c3-wake: stop $HOST"
  rpv cloud stop "$HOST" --yes 2>&1 | tee "$EV/c3-stop.txt"
  probe --timeout 5000 $U > "$EV/c3-while-asleep.jsonl"; cut -c1-200 "$EV/c3-while-asleep.jsonl"
  log "c3-wake: wake $HOST"
  t0=$(date +%s%3N)
  ( rpv cloud wake "$HOST" > "$EV/c3-wake.txt" 2>&1; echo "wake cli exit $? after $(( $(date +%s%3N) - t0 )) ms" >> "$EV/c3-wake.txt" ) &
  wpid=$!
  # time to 200 measured from the wake command's start, from agentbox over the tailnet
  probe --timeout 3000 --wait-200 600000 $U | tee "$EV/c3-wake-probe.jsonl"
  wait $wpid; cat "$EV/c3-wake.txt"
  log "c3-wake: probes done $(( $(date +%s%3N) - t0 )) ms after wake start"
  sx "$SB" state.sh after-wake > "$EV/c3-after-wake.txt"
  rpv cloud port list "$HOST" --json > "$EV/c3-port-list-after-wake.json"
  python3 "$HERE/judge.py" c3 "$EV" "$HOST" | tee -a "$EV/verdicts.txt"
  ;;
c4)
  # SUGGESTED: an agent-started listener is suggested, not published until `port open`.
  PP="${1:-5174}"; CP="${2:-5175}"
  log "c4: agent listener :$PP (panel), control :$CP (no panel)"
  sx "$SB" agent-listener.sh "$PV_SESSION_REPO" "$PP" "$CP" | tee "$EV/c4-agent-listener.txt"
  rpv cloud port list "$HOST" --json > "$EV/c4-list-before-open.json"
  probe --timeout 8000 "https://$DNS:$PP/" > "$EV/c4-probe-before-open.jsonl"; cat "$EV/c4-probe-before-open.jsonl"
  rpv cloud port open "$HOST" "$PP" --name pa-suggested --json > "$EV/c4-open.json" 2>&1; cat "$EV/c4-open.json"
  probe --timeout 15000 "https://$DNS:$PP/" > "$EV/c4-probe-after-open.jsonl"; cut -c1-300 "$EV/c4-probe-after-open.jsonl"
  rpv cloud port list "$HOST" --json > "$EV/c4-list-after-open.json"
  python3 "$HERE/judge.py" c4 "$EV" "$HOST" "$PP" "$CP" | tee -a "$EV/verdicts.txt"
  rpv cloud port close "$HOST" pa-suggested --json > "$EV/c4-close.json" 2>&1
  sx "$SB" agent-listener.sh --stop pa-devserver "$CP" | tee -a "$EV/c4-agent-listener.txt"
  ;;
c5)
  # REFUSALS: 443, the daemon's port, a privileged tailnet port, a foreign local service; close restores; no Funnel.
  sx "$SB" state.sh c5-before > "$EV/c5-state-before.txt"
  : > "$EV/c5-refusals.txt"
  try() { echo "\$ runpane cloud port open $HOST $*" >> "$EV/c5-refusals.txt"; rpv cloud port open "$HOST" "$@" >> "$EV/c5-refusals.txt" 2>&1; echo "exit=$?" >> "$EV/c5-refusals.txt"; }
  try 443
  try 9443 --https-port 443
  try 42137
  try 9444 --https-port 42137
  try 8080 --https-port 80 --name pa-priv80
  try 22 --name pa-sshd
  try 8787 --https-port 8788 --name pa-dup
  cat "$EV/c5-refusals.txt"
  rpv cloud port list "$HOST" --json > "$EV/c5-list-after-tries.json"
  sx "$SB" state.sh c5-after-tries > "$EV/c5-state-after-tries.txt"
  # close what the tries opened (if any), then prove the state is back
  for n in pa-priv80 pa-sshd pa-dup; do rpv cloud port close "$HOST" "$n" --json >> "$EV/c5-closes.txt" 2>&1; done
  rpv cloud port close "$HOST" pa-clash --json >> "$EV/c5-closes.txt" 2>&1
  sx "$SB" state.sh c5-after-close > "$EV/c5-state-after-close.txt"
  python3 "$HERE/judge.py" c5 "$EV" "$HOST" | tee -a "$EV/verdicts.txt"
  ;;
c6)
  : "${PV_GROUP_FILE:?}"
  for engine in chromium webkit; do
    REVIEWER="p5-verify $engine" NOTE="[p5-verify TEST, ignore] $engine walk at $(ts) on the integrated ports release ($PV_TAG)" \
      node "$HERE/taste-walk.cjs" "$PV_GROUP_FILE" "$EV/c6-shots-$engine" "$engine" | tee "$EV/c6-walk-$engine.txt"
  done
  second cloud port list "${PV_SECOND_HOST:?}" --json > "$EV/c6-scratch-port-list.json" 2>&1
  second cloud port list "$PV_SECOND_HOST" > "$EV/c6-scratch-port-list.txt" 2>&1; cat "$EV/c6-scratch-port-list.txt"
  python3 "$HERE/judge.py" c6 "$EV" "$PV_SECOND_HOST" | tee -a "$EV/verdicts.txt"
  ;;
destroy)
  log "destroy $HOST ($SB)"
  rpv cloud destroy "$HOST" --yes 2>&1 | tee "$EV/destroy.txt"
  "$HOME/rc-loop/bin/ts-api.sh" GET /tailnet/-/devices | python3 -c "import json,sys;t=sys.stdin.read().split('__HTTP__')[0];print([d['hostname'] for d in json.loads(t)['devices'] if 'p5verify' in d['hostname']])" | tee -a "$EV/destroy.txt"
  echo "$(date -u +%FT%TZ) DESTROYED $SB ($HOST) via cloud destroy" >> "$HOME/rc-loop/destroyed.txt"
  ;;
*) sed -n '2,14p' "$0"; exit 2 ;;
esac
