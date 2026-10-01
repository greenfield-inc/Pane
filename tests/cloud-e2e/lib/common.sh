# shellcheck shell=bash
# Shared setup for the Runpane Cloud live gates. Source it from a gate script:
#   . "$(dirname "$0")/../lib/common.sh"; e2e_init <gate-name>
#
# Every run gets its own evidence directory:
#   $E2E_EVIDENCE_ROOT/<run-id>/{gate.log,results.jsonl,resources.txt,...}
# Resources (sandboxes, tailnet nodes) created by the run are listed in resources.txt and torn
# down on exit (tailnet device first, then sandbox) unless KEEP=1.

set -o pipefail

E2E_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; export E2E_LIB
E2E_ROOT="$(cd "$E2E_LIB/.." && pwd)"
E2E_EVIDENCE_ROOT="${E2E_EVIDENCE_ROOT:-$HOME/rc-loop/evidence/e2e-gates}"
E2E_MATRIX="${E2E_MATRIX:-$HOME/rc-loop/results/e2e-matrix.md}"
E2E_PREFIX="${E2E_PREFIX:-rp-loop-e2e}"

cl() { python3 "$E2E_LIB/cloudlab.py" "$@"; }

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

e2e_init() {
  E2E_GATE="$1"
  E2E_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$E2E_GATE"   # never inherit: a stale export would mix runs
  E2E_RUN_DIR="$E2E_EVIDENCE_ROOT/$E2E_RUN_ID"
  E2E_SECRETS="$E2E_RUN_DIR/.secrets"
  mkdir -p "$E2E_RUN_DIR"
  (umask 077; mkdir -p "$E2E_SECRETS")
  chmod 700 "$E2E_SECRETS"
  export E2E_GATE E2E_RUN_ID E2E_RUN_DIR E2E_SECRETS
  export E2E_TARGET="${E2E_TARGET:-unspecified}"
  : > "$E2E_RUN_DIR/resources.txt"
  exec > >(tee -a "$E2E_RUN_DIR/gate.log") 2>&1
  log "run $E2E_RUN_ID gate=$E2E_GATE target=$E2E_TARGET evidence=$E2E_RUN_DIR"
  trap e2e_finish EXIT
  trap 'exit 143' TERM INT
}

# rec <check> <PASS|FAIL|XFAIL|SKIP|BLOCKED|INFO> <detail> [evidence-file] [k=v ...]
rec() {
  local check="$1" status="$2" detail="$3" ev="${4:-}"
  shift 3; [ $# -gt 0 ] && shift
  local margs=()
  for m in "$@"; do margs+=(--metric "$m"); done
  cl record "$E2E_GATE" "$check" "$status" "$detail" --evidence "$ev" "${margs[@]}"
}

# Save a JSON/text blob as an evidence file and echo its path.
ev() { local name="$1"; cat > "$E2E_RUN_DIR/$name"; echo "$E2E_RUN_DIR/$name"; }

# jq-free JSON field read: jget '<python expr on d>' <<<"$json"
jget() { cl json "$1"; }

ms_now() { date +%s%3N; }
secs_since() { awk -v a="$1" -v b="$(ms_now)" 'BEGIN{printf "%.2f", (b-a)/1000}'; }

register_resource() { echo "$1 $2 $3" >> "$E2E_RUN_DIR/resources.txt"; }  # kind id name

# sb_create <suffix> <small|default|large> [from-named-snapshot] -> prints sandbox id
sb_create() {
  local name="$E2E_PREFIX-$1" sid
  sid=$(cl boat create "$name" "$2" ${3:+--from "$3"}) || return 1
  register_resource sandbox "$sid" "$name"
  echo "$sid"
}

# sbx <sandbox-id> [timeout] <<'SH' ... SH   : run a script inside the sandbox (stdin), stream output
sbx() {
  { echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus'; cat; } \
    | cl boat exec "$1" - --timeout "${2:-600}"
}

# Tailnet join via a single-use tag:rp-session key. Key goes through a 0600 file and is shredded.
sb_tailnet_join() {
  local sid="$1" host="$2" keyf="$E2E_SECRETS/tskey-$host"
  cl ts mint "$keyf" >/dev/null || return 1
  cl boat put "$sid" "$keyf" "rcl/tskey" || { shred -u "$keyf"; return 1; }
  shred -u "$keyf"
  sbx "$sid" 300 <<SH
set -e
chmod 600 /home/user/rcl/tskey
if ! command -v tailscale >/dev/null; then curl -fsSL https://tailscale.com/install.sh | sh >/tmp/ts-install.log 2>&1; fi
sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
sudo tailscale up --auth-key=file:/home/user/rcl/tskey --hostname=$host --operator=user
shred -u /home/user/rcl/tskey
tailscale status --json | python3 -c "import json,sys;d=json.load(sys.stdin);s=d['Self'];print(json.dumps({'id':s['ID'],'dns':s['DNSName'],'ips':s['TailscaleIPs'],'tags':s.get('Tags')}))"
SH
  local node
  node=$(cl ts find "$host" | jget 'd[0]["nodeId"] if d else ""')
  [ -n "$node" ] && register_resource tsnode "$node" "$host" && \
    { [ -f "$HOME/rc-loop/tailnet-nodes.txt" ] && echo "$node $host $sid e2e-gates" >> "$HOME/rc-loop/tailnet-nodes.txt"; }
  echo "$node"
}

e2e_cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    log "KEEP=1: leaving resources in place:"; cat "$E2E_RUN_DIR/resources.txt" >&2; return 0
  fi
  local kind id name
  # local helper processes (e.g. a coordinator serve) first
  while read -r kind id name; do [ "$kind" = pid ] && kill -TERM "$id" 2>/dev/null; done < "$E2E_RUN_DIR/resources.txt"
  # tailnet devices first (M0: tailscale logout does not remove tagged devices)
  while read -r kind id name; do
    [ "$kind" = tsnode ] && { log "delete tailnet device $id ($name)"; cl ts delete "$id" >/dev/null || log "WARN ts delete $id failed"; }
  done < "$E2E_RUN_DIR/resources.txt"
  while read -r kind id name; do
    [ "$kind" = sandbox ] && { log "delete sandbox $id ($name)"; cl boat delete "$id" >/dev/null || log "WARN boat delete $id failed"; }
  done < "$E2E_RUN_DIR/resources.txt"
  true
}

e2e_finish() {
  local rc=$?
  # teardown must survive a dead tee (e.g. the run was stopped with its children): no SIGPIPE, log to file
  trap '' PIPE; exec >>"$E2E_RUN_DIR/gate.log" 2>&1
  e2e_cleanup
  [ "${E2E_NO_MATRIX:-0}" = 1 ] || cl matrix >/dev/null 2>&1 || true
  # redact defensively: no pairing code or bearer token may survive in evidence
  grep -rlE 'pane-remote://[A-Za-z0-9_-]{20,}|tskey-[a-z]+-[A-Za-z0-9]|boat_[A-Za-z0-9]{16,}' "$E2E_RUN_DIR" --exclude-dir=.secrets 2>/dev/null \
    | while read -r f; do sed -i -E 's#pane-remote://[A-Za-z0-9_=-]+#pane-remote://<redacted>#g; s#tskey-[a-z]+-[A-Za-z0-9-]+#tskey-<redacted>#g; s#boat_[A-Za-z0-9]+#boat_<redacted>#g' "$f"; log "redacted secrets in $f"; done
  rm -rf "$E2E_SECRETS"
  log "done rc=$rc; results: $E2E_RUN_DIR/results.jsonl; matrix: $E2E_MATRIX"
}

# wait_start_budget <starts-needed> : respect boat's account-wide START limit (create/fork/resume: 60/h, 200/day).
# Reads GET /limits (the same counter as ~/rc-loop/bin/starts-left.sh). Hour exhausted or too few left -> wait.
# Day remaining below the reserve (E2E_DAY_RESERVE, default 25) -> record BLOCKED, file a request, exit 0.
wait_start_budget() {
  local need="${1:-2}" out h d
  [ -x "$HOME/rc-loop/bin/starts-left.sh" ] || return 0   # only the build loop shares one boat account
  while :; do
    out=$(python3 - <<'PY'
import sys; sys.path.insert(0, __import__("os").environ["E2E_LIB"])
import cloudlab
st, p = cloudlab.boat("GET", "/limits")
s = (p or {}).get("starts", {}) if isinstance(p, dict) else {}
print(s.get("hour", {}).get("remaining", -1), s.get("day", {}).get("remaining", -1))
PY
)
    read -r h d <<<"$out"
    [ -z "$h" ] || [ "$h" = -1 ] && { log "boat /limits unreadable; proceeding"; return 0; }
    if [ "$d" -lt $(( ${E2E_DAY_RESERVE:-25} + need )) ]; then
      rec start-budget BLOCKED "boat day start budget too low (remaining $d, need $need + reserve ${E2E_DAY_RESERVE:-25}); not started"
      [ -d "$HOME/rc-loop/ledger" ] && echo "- $(date -u +%FT%TZ) e2e-gates $E2E_GATE needs $need starts (day remaining $d)" >> "$HOME/rc-loop/ledger/start-requests.md"
      exit 0
    fi
    [ "$h" -ge "$need" ] && { log "boat starts: hour remaining $h, day remaining $d; need $need"; return 0; }
    log "boat start budget: hour remaining $h (need $need), day remaining $d; waiting 5 min"; sleep 300
  done
}
