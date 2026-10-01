# shellcheck shell=bash
# Helpers for the Phase 3 broker gates (Session -> coordinator -> GitHub, no laptop at runtime).
#   fake_deploy     run fakegithub.py on the coordinator sandbox's loopback (systemd user unit)
#   fake_admin      GET/POST the fake's admin API from inside the coordinator (boat exec, never the tailnet)
#   bcall           a raw broker call from inside a Session, with that Session's own peer token (peers.json)
#   app_jwt         an RS256 GitHub App JWT from a PEM (openssl), for the P4 cleanup path
# Every command that runs in a sandbox goes through the boat exec API, which is not the tailnet: the harness
# can watch a Session without being a client of it.
# CONTRACT ADAPTERS: the few `runpane` spellings owned by p3-broker / p3-agent-cli are the functions named
# broker_* and agent_* below. Keep them in one place so a flag rename is a one-line change.

FAKE_PORT="${E2E_FAKE_PORT:-47399}"
FAKE_DIR=/home/user/.local/share/rp-loop-fakegithub
FAKE_UNIT=rp-loop-fakegithub

# fake_deploy <coordinator-sandbox> <owner/repo> <app-id> <app-public-key-pem> <installation-id> [extra-repo...]
fake_deploy() {
  local sid="$1" repo="$2" app="$3" pub="$4" inst="$5"; shift 5
  cl boat put "$sid" "$E2E_LIB/fakegithub.py" "rcl/fakegithub.py" || return 1
  cl boat put "$sid" "$pub" "rcl/fake-app.pub" || return 1
  # FAKE_GRANTS: extra installation permissions (default: the Checks/Commit statuses READ that Red is asked to add)
  local grants=""; for g in ${FAKE_GRANTS-checks=read statuses=read}; do grants+="--grant $g "; done
  local extra=""; for r in "$@"; do extra+="python3 $FAKE_DIR/fakegithub.py init --state $FAKE_DIR/state --repo $r --app-id $app --app-public-key /home/user/rcl/fake-app.pub --installation-id $inst $grants>/dev/null; "; done
  sbx "$sid" 300 <<SH
set -e
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
command -v git >/dev/null || sudo apt-get install -y git >/dev/null 2>&1
systemctl --user stop $FAKE_UNIT 2>/dev/null || true
rm -rf $FAKE_DIR/state   # a fresh fake per run
mkdir -p $FAKE_DIR && install -m 755 /home/user/rcl/fakegithub.py $FAKE_DIR/fakegithub.py
python3 $FAKE_DIR/fakegithub.py init --state $FAKE_DIR/state --repo $repo --app-id $app --app-public-key /home/user/rcl/fake-app.pub --installation-id $inst $grants
$extra
systemctl --user stop $FAKE_UNIT 2>/dev/null || true
systemctl --user reset-failed $FAKE_UNIT 2>/dev/null || true
systemd-run --user --unit=$FAKE_UNIT --collect python3 $FAKE_DIR/fakegithub.py serve --state $FAKE_DIR/state --host 127.0.0.1 --port $FAKE_PORT >/dev/null
for i in \$(seq 50); do curl -s -o /dev/null http://127.0.0.1:$FAKE_PORT/rate_limit && break; sleep 0.2; done
echo "fake: \$(systemctl --user is-active $FAKE_UNIT) on 127.0.0.1:$FAKE_PORT; listeners: \$(ss -Hltn "sport = :$FAKE_PORT" | awk '{print \$4}' | tr '\n' ' ')"
SH
}

# fake_admin <coordinator-sandbox> <GET|POST> <path> [json-body] : prints the response body
fake_admin() {
  local sid="$1" m="$2" p="$3" data=""
  if [ -n "${4:-}" ]; then
    printf '%s' "$4" > "$E2E_RUN_DIR/.fake-admin-body.json"
    cl boat put "$sid" "$E2E_RUN_DIR/.fake-admin-body.json" rcl/fake-admin-body.json >/dev/null || return 1
    data="-H 'Content-Type: application/json' --data-binary @/home/user/rcl/fake-admin-body.json"
  fi
  sbx "$sid" 120 <<SH
curl -sS -X $m -H "X-Fake-Admin: \$(cat $FAKE_DIR/state/admin-token)" $data "http://127.0.0.1:$FAKE_PORT$p"
SH
}

# fake_master <coordinator-sandbox> <owner/repo> [branch] : sha of the default branch in the fake
fake_master() {
  sbx "$1" 60 <<<"git --git-dir=$FAKE_DIR/state/git/$2.git rev-parse refs/heads/${3:-master}" | tail -1
}

# bcall_install <session-sandbox> : put the raw-call helper into the Session (prints nothing secret)
bcall_install() {
  sbx "$1" 60 <<'SH'
mkdir -p /home/user/rcl
cat > /home/user/rcl/bcall <<'PY'
#!/usr/bin/env python3
"""bcall METHOD PATH [json] : call the coordinator with THIS Session's peer token (from peers.json). Prints
   '<http-status> <body>'. The token is never printed. BCALL_TOKEN_FILE overrides the token source."""
import json, os, sys, urllib.request, urllib.error
m, p = sys.argv[1], sys.argv[2]
body = sys.argv[3].encode() if len(sys.argv) > 3 else None
if body and body.startswith(b'@'):
    body = open(body[1:].decode(), 'rb').read()
d = json.load(open(os.path.expanduser('~/.config/runpane-cloud/peers.json')))
base = os.environ.get('BCALL_BASE') or d['coordinator']['baseUrl']
tok = open(os.environ['BCALL_TOKEN_FILE']).read().strip() if os.environ.get('BCALL_TOKEN_FILE') else d['coordinator']['token']
req = urllib.request.Request(base.rstrip('/') + p, data=body, method=m,
                             headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print(r.status, r.read().decode()[:2000])
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode()[:2000])
except Exception as e:  # noqa
    print(0, json.dumps({"transport": str(e)[:300]}))
PY
chmod 700 /home/user/rcl/bcall
cat > /home/user/rcl/pushprobe <<'PY'
#!/usr/bin/env python3
"""pushprobe REPO BRANCH BUNDLE_B64_FILE [EXTRA_JSON] : raw POST /cloud/github/push with this Session's token."""
import json, os, sys
body = {"repo": sys.argv[1], "branch": sys.argv[2], "bundle": open(sys.argv[3]).read().strip()}
body.update(json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else {})
path = os.path.expanduser('~/rcl/push-body.json')
json.dump(body, open(path, 'w'))
os.execv(os.path.expanduser('~/rcl/bcall'), ['bcall', 'POST', '/cloud/github/push', '@' + path])
PY
chmod 700 /home/user/rcl/pushprobe
echo "bcall installed; coordinator $(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.config/runpane-cloud/peers.json')))['coordinator']['baseUrl'])")"
SH
}

# bcall <sandbox> <METHOD> <path> [json] : run bcall in the sandbox; prints "<status> <body>"
bcall() {
  local sid="$1" m="$2" p="$3" body="${4:-}"
  local q; q=$(printf '%q ' "$m" "$p" ${body:+"$body"})
  sbx "$sid" 120 <<<"${BCALL_ENV:-} /home/user/rcl/bcall $q" | tail -1
}

# bundle_b64 <sandbox> <repo-dir> <rev-range...> : base64 of a git bundle built in the sandbox, into a sandbox file
# (used for raw /cloud/github/push probes; prints the sandbox path of the base64 file)
bundle_file() {
  local sid="$1" dir="$2" out="$3"; shift 3
  local q; q=$(printf '%q ' "$@")
  sbx "$sid" 120 <<SH
cd $dir && git bundle create /home/user/rcl/probe.bundle $q >/dev/null 2>&1 && base64 -w0 /home/user/rcl/probe.bundle > $out && echo "$out \$(stat -c %s /home/user/rcl/probe.bundle)"
SH
}

# app_jwt <pem-file> <app-id> : an RS256 GitHub App JWT (9 min), for cleanup with the user's own App key
app_jwt() {
  local h p s now; now=$(date +%s)
  h=$(printf '{"alg":"RS256","typ":"JWT"}' | basenc --base64url | tr -d '=\n')
  p=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' $((now-60)) $((now+540)) "$2" | basenc --base64url | tr -d '=\n')
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign "$1" | basenc --base64url | tr -d '=\n')
  printf '%s.%s.%s' "$h" "$p" "$s"
}

# ---------------------------------------------------------------- CONTRACT ADAPTERS (p3-broker / p3-agent-cli)
# broker_set_app <app-id> <pem> <installation-id> [api-base] [git-base]
broker_set_app() {
  local extra=(); [ -n "${4:-}" ] && extra+=(--api-base-url "$4"); [ -n "${5:-}" ] && extra+=(--git-base-url "$5")
  rpc cloud coordinator github set --app-id "$1" --private-key-file "$2" --installation-id "$3" "${extra[@]}" ${BROKER_SET_FLAGS---no-verify} --json   # the laptop can't reach a fake on the coordinator's loopback
}
broker_set_pat() {
  local extra=(); [ -n "${2:-}" ] && extra+=(--api-base-url "$2"); [ -n "${3:-}" ] && extra+=(--git-base-url "$3")
  rpc cloud coordinator github set --pat-file "$1" "${extra[@]}" ${BROKER_SET_FLAGS:-} --json
}
broker_status() { rpc cloud coordinator github status --json; }
broker_audit()  { rpc cloud coordinator github audit --json; }
# broker_connect <host> <owner/repo> : allowlist the repo for the Session and install the shim/helper
broker_connect() { rpc cloud github connect "$1" --repo "$2" --broker ${BROKER_CONNECT_FLAGS:-} --json; }
# in-Session spellings (run through sbx): the Session's own runpane and the gh shim
AGENT_RP='$HOME/.pane_remote/bin/runpane'
agent_push_cmd() { echo "$AGENT_RP cloud agent github push --path $1 --branch $2 --json"; }
