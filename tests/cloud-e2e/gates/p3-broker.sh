#!/usr/bin/env bash
# P3 broker gate (phase3-design §9 P2 + P3): Session -> coordinator -> GitHub, with no laptop in the path.
#   A fresh coordinator (`runpane cloud coordinator deploy`) runs the broker, pointed at a fake GitHub
#   (lib/fakegithub.py: real `git http-backend` + mock REST, App JWT + downscoped installation tokens) that listens
#   on the coordinator's LOOPBACK only. A fresh cloud Session (`runpane cloud new`) gets the repo allowlisted
#   (`cloud github connect --broker`). A REAL Claude agent in the Session pushes a branch, opens a draft PR and an
#   issue through `runpane cloud agent github` / the gh shim, with no client of ours attached while it works.
#   Then the refusals are probed live from inside the Session (raw calls with its own peer token, as a hostile
#   agent would): master, outside the namespace, a workflow-file change, merge, another Session's PR/issue,
#   a repo outside the allowlist, the peer token used from another node. The fake's own log, the coordinator's
#   audit, the Session's sockets and the tailnet ACL are the evidence.
# Starts: 2 (coordinator + Session), boat org from E2E_BOAT_ORG (default test).
# Env: E2E_RUNPANE_TGZ_URL (CLI under test; default dist-current), E2E_DAEMON_DEB_URL (Session daemon; default dist-current),
#      E2E_CLAUDE=0 to skip the agent step, E2E_AGENT_TIMEOUT (s, default 900), KEEP=1
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/cli.sh"; . "$E2E_LIB/provision.sh"; . "$E2E_LIB/fixtures.sh"; . "$E2E_LIB/broker.sh"
export E2E_PREFIX="${E2E_PREFIX_OVERRIDE:-rp-loop-p3e2e}"
export E2E_EVIDENCE_ROOT="${E2E_EVIDENCE_ROOT_OVERRIDE:-$HOME/rc-loop/evidence/p3-e2e}"
export E2E_DAEMON_DEB_URL="${E2E_DAEMON_DEB_URL-$(dist_url deb)}"
export E2E_RUNPANE_TGZ_URL="${E2E_RUNPANE_TGZ_URL-$(dist_url tgz)}"
BOAT_ORG="${E2E_BOAT_ORG:-test}"; export CLOUDLAB_BOAT_ORG="$BOAT_ORG"   # every raw boat call of the harness names the wallet
e2e_init P3-broker
wait_start_budget 2
cli_resolve || { rec cli BLOCKED "runpane CLI under test not installable"; exit 1; }
E2E_TARGET="${E2E_TARGET_OVERRIDE:-${E2E_CLI_SOURCE##*/}}"; export E2E_TARGET
# E2E_P3_PHASE=infra: only setup + coordinator + fake + ACL (for an older build: proves the environment, then stops, KEEP)
PHASE="${E2E_P3_PHASE:-full}"; [ "$PHASE" = infra ] && export KEEP=1
[ "$PHASE" = full ] && rpc cloud coordinator github --help 2>&1 | grep -qiE 'unknown|not available' && { rec broker BLOCKED "no 'cloud coordinator github' in $E2E_CLI_SOURCE"; exit 0; }

OWNER=rp-e2e; REPO="$OWNER/app"; OTHER="$OWNER/other"; APP_ID=31337; INST=4242
AGENTBOX_TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
say() { log "== $*"; }

# ================================================================ setup (isolated cloud dir, test wallet)
say "setup"
CT="$E2E_SECRETS/claude.token"; (umask 077; "${E2E_CLAUDE_TOKEN_CMD:-$HOME/rc-loop/bin/claude-token.sh}" | tr -d '\r\n' > "$CT")
out=$(cloud_setup_from_loop_secrets --boat-org "$BOAT_ORG" --no-golden --pane-deb-url "$E2E_DAEMON_DEB_URL" --claude-token-file "$CT" 2>&1); rc=$?
shred -u "$CT"; printf '%s\n' "$out" | ev setup.json >/dev/null
[ $rc = 0 ] && rec setup PASS "cloud setup (wallet $BOAT_ORG, isolated RUNPANE_CLOUD_DIR, daemon ${E2E_DAEMON_DEB_URL##*/})" "$E2E_RUN_DIR/setup.json" \
  || { rec setup FAIL "rc=$rc" "$E2E_RUN_DIR/setup.json"; exit 1; }

# ================================================================ coordinator (1 start)
say "coordinator deploy"
t0=$(ms_now)
rpc cloud coordinator deploy --yes --boat-org "$BOAT_ORG" --name "$E2E_PREFIX-coord" --no-reconcile --idle-check-seconds 3600 --key-ttl 2d --json \
  > "$E2E_RUN_DIR/coordinator-deploy.json" 2> "$E2E_RUN_DIR/coordinator-deploy.stderr"; rc=$?
DEP=$(python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1])).get("coordinator",{}).get("deployment") or {}))' "$RUNPANE_CLOUD_DIR/settings.json" 2>/dev/null)
C_ID=$(jget 'd.get("sandboxId","")' <<<"$DEP"); C_HOST=$(jget 'd.get("hostname","")' <<<"$DEP"); C_NODE=$(jget 'd.get("nodeId","")' <<<"$DEP"); C_URL=$(jget 'd.get("baseUrl","")' <<<"$DEP")
[ -n "$C_NODE" ] && register_resource tsnode "$C_NODE" "$C_HOST"; [ -n "$C_ID" ] && register_resource sandbox "$C_ID" "$C_HOST"
[ -n "$C_ID" ] && echo "$C_ID $C_HOST p3-e2e(coordinator)" >> "$HOME/rc-loop/sandboxes.txt"
[ $rc = 0 ] && [ -n "$C_ID" ] && rec coordinator.deploy PASS "coordinator $C_HOST ($C_ID) at $C_URL in $(secs_since "$t0")s, wallet $BOAT_ORG" "$E2E_RUN_DIR/coordinator-deploy.json" "seconds=$(secs_since "$t0")" \
  || { rec coordinator.deploy FAIL "rc=$rc: $(tail -c 300 "$E2E_RUN_DIR/coordinator-deploy.stderr")" "$E2E_RUN_DIR/coordinator-deploy.stderr"; exit 1; }
[ "$(cl boat get "$C_ID" --field team)" = "$(python3 -c 'import json,sys;print((json.load(open(sys.argv[1])).get("boatOrg") or {}).get("id",""))' "$RUNPANE_CLOUD_DIR/settings.json")" ] || true

# ================================================================ fake GitHub on the coordinator's loopback
say "fake GitHub"
openssl genrsa -out "$E2E_SECRETS/app.pem" 2048 2>/dev/null && chmod 600 "$E2E_SECRETS/app.pem"
openssl rsa -in "$E2E_SECRETS/app.pem" -pubout -out "$E2E_RUN_DIR/fake-app.pub" 2>/dev/null
fake_deploy "$C_ID" "$REPO" "$APP_ID" "$E2E_RUN_DIR/fake-app.pub" "$INST" "$OTHER" | ev fake-deploy.txt >/dev/null
MASTER0=$(fake_master "$C_ID" "$REPO")
lst=$(sbx "$C_ID" 60 <<<"ss -Hltn 'sport = :$FAKE_PORT' | awk '{print \$4}'")
[[ "$MASTER0" =~ ^[0-9a-f]{40}$ ]] && [ "$(tr -d '\n ' <<<"$lst")" = "127.0.0.1:$FAKE_PORT" ] \
  && rec fake.deploy PASS "fake GitHub on the coordinator, listening ONLY on 127.0.0.1:$FAKE_PORT; $REPO master=$MASTER0; App $APP_ID installed on $REPO and $OTHER (no workflows permission, no branch protection)" "$E2E_RUN_DIR/fake-deploy.txt" \
  || { rec fake.deploy FAIL "master=$MASTER0 listeners=$lst" "$E2E_RUN_DIR/fake-deploy.txt"; exit 1; }

if [ "$PHASE" = infra ]; then
  acl=$(sbx "$C_ID" 120 <<SH
for port in 443 22 42137; do r=\$(curl -s -o /dev/null -m 6 -w '%{http_code}' http://$AGENTBOX_TS_IP:\$port/ 2>/dev/null); echo "agentbox:\$port=\$r"; done
c=\$(curl -s -o /dev/null -m 8 -w '%{http_code}' $C_URL/cloud/github/status); echo "own-broker-status=\$c"
python3 --version; git --version; tailscale status 2>/dev/null | head -8
SH
)
  printf '%s\n' "$acl" | ev infra-acl.txt >/dev/null
  ! grep -qE '^agentbox:[0-9]+=[1-9]' <<<"$acl" && rec acl.rp-session-to-agentbox-blocked PASS "from the coordinator (tag:rp-session): agentbox $AGENTBOX_TS_IP unreachable on 443/22/42137" "$E2E_RUN_DIR/infra-acl.txt" \
    || rec acl.rp-session-to-agentbox-blocked FAIL "$(tr '\n' ' ' <<<"$acl" | head -c 300)" "$E2E_RUN_DIR/infra-acl.txt"
  log "infra phase done; coordinator $C_HOST ($C_ID) kept in $RUNPANE_CLOUD_DIR for an in-place redeploy"; exit 0
fi

say "broker: github set (App mode, fake base URLs)"
broker_set_app "$APP_ID" "$E2E_SECRETS/app.pem" "$INST" "http://127.0.0.1:$FAKE_PORT" "http://127.0.0.1:$FAKE_PORT" > "$E2E_RUN_DIR/github-set.json" 2>&1; rc=$?
broker_status > "$E2E_RUN_DIR/github-status.json" 2>&1
# where does the App key live? match by size + sha256 (no key material leaves agentbox for this check)
PEM_SHA=$(sha256sum < "$E2E_SECRETS/app.pem" | cut -d' ' -f1); PEM_SIZE=$(stat -c %s "$E2E_SECRETS/app.pem")
key_copies() {  # key_copies <sandbox> : "<mode> <path>" of every file with the App key's exact bytes
  sbx "$1" 120 <<SH
find /home /tmp /etc /var/tmp /root -xdev -type f -size ${PEM_SIZE}c 2>/dev/null | while read -r f; do
  [ "\$(sha256sum < "\$f" 2>/dev/null | cut -d' ' -f1)" = $PEM_SHA ] && echo "\$(stat -c %a "\$f") \$f"; done; true
SH
}
pem_where=$(key_copies "$C_ID"); printf '%s\n' "$pem_where" | ev app-key-copies-coordinator.txt >/dev/null
grep -q '"app"' "$E2E_RUN_DIR/github-status.json" && [ $rc = 0 ] && [ "$pem_where" = "600 /home/user/.config/runpane-cloud-coordinator/github/app.pem" ] \
  && rec broker.set PASS "github set -> the coordinator loaded the App from the fake (slug + repos in status); key 0600 at ~/.config/runpane-cloud-coordinator/github/app.pem, the only copy on the box" "$E2E_RUN_DIR/github-status.json" \
  || rec broker.set FAIL "rc=$rc; key copies: $(tr '\n' ';' <<<"$pem_where")" "$E2E_RUN_DIR/github-set.json"
grep -rlF --exclude-dir=.secrets -- "$(sed -n 2p "$E2E_SECRETS/app.pem")" "$E2E_RUN_DIR" >/dev/null 2>&1 && rec broker.set-no-key-in-output FAIL "private key material in evidence" || rec broker.set-no-key-in-output PASS "no private key material in any CLI output or evidence file"

# ================================================================ Session (1 start)
say "cloud new"
t0=$(ms_now)
rpc cloud new --label "p3e2e-$(date -u +%H%M%S)" --boat-org "$BOAT_ORG" --size default --yes --json > "$E2E_RUN_DIR/new.json" 2> "$E2E_RUN_DIR/new.stderr"; rc=$?
rec_file=$(ls -t "$RUNPANE_CLOUD_DIR"/hosts/*.json 2>/dev/null | head -1)
[ -n "$rec_file" ] || { rec session.new FAIL "rc=$rc; no host record: $(tail -c 300 "$E2E_RUN_DIR/new.stderr")" "$E2E_RUN_DIR/new.stderr"; exit 1; }
HOST=$(jget 'd["profile"]["cloud"]["hostname"]' < "$rec_file"); S_ID=$(jget 'd["profile"]["cloud"]["sandboxId"]' < "$rec_file")
S_NODE=$(jget 'd["profile"]["cloud"]["nodeId"]' < "$rec_file")
register_resource sandbox "$S_ID" "$HOST"; [ -n "$S_NODE" ] && register_resource tsnode "$S_NODE" "$HOST"
echo "$S_ID $HOST p3-e2e(session)" >> "$HOME/rc-loop/sandboxes.txt"
[ $rc = 0 ] && rec session.new PASS "cloud new -> $HOST ($S_ID) in $(secs_since "$t0")s, wallet $BOAT_ORG" "$E2E_RUN_DIR/new.json" "seconds=$(secs_since "$t0")" \
  || { rec session.new FAIL "rc=$rc: $(tail -c 300 "$E2E_RUN_DIR/new.stderr")" "$E2E_RUN_DIR/new.stderr"; exit 1; }
PFX="cloud/$HOST/"

say "seed the Session's clone (origin = https://github.com/$REPO, origin/master = the fake's master)"
sbx "$C_ID" 60 <<<"git --git-dir=$FAKE_DIR/state/git/$REPO.git bundle create /home/user/rcl/seed.bundle master >/dev/null 2>&1; ls -l /home/user/rcl/seed.bundle" >/dev/null
cl boat fetch "$C_ID" /home/user/rcl/seed.bundle "$E2E_SECRETS/seed.bundle" && cl boat put "$S_ID" "$E2E_SECRETS/seed.bundle" rcl/seed.bundle >/dev/null
sbx "$S_ID" 300 <<SH | ev session-seed.txt >/dev/null
set -e
git clone -q /home/user/rcl/seed.bundle /home/user/app -b master
cd /home/user/app && git remote set-url origin https://github.com/$REPO.git
git update-ref refs/remotes/origin/master \$(git rev-parse HEAD)
git config --global user.name "cloud agent ($HOST)"; git config --global user.email "agent@$HOST.invalid"
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude.json'); d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault('projects', {}).setdefault('/home/user/app', {})['hasTrustDialogAccepted'] = True
json.dump(d, open(p, 'w'))
PY
\$HOME/.pane_remote/bin/runpane repos add --path /home/user/app --name app --yes --json | head -c 300; echo
git log --oneline -1; git branch -a
SH
say "broker: allowlist $REPO for $HOST"
broker_connect "$HOST" "$REPO" > "$E2E_RUN_DIR/connect.json" 2>&1; rc=$?
shim=$(sbx "$S_ID" 60 <<'SH'
export PATH="$HOME/.local/bin:$PATH"
echo "gh=$(command -v gh)"; gh auth status 2>&1 | head -3; gh repo delete x 2>&1 | head -1; echo "exit=$?"
SH
)
printf '%s\n' "$shim" | ev shim.txt >/dev/null
[ $rc = 0 ] && grep -q "gh=/home/user/.local/bin/gh" <<<"$shim" && grep -qi "not available in a runpane cloud Session" <<<"$shim" \
  && rec session.connect PASS "github connect --broker: $REPO allowlisted; gh shim installed ahead of PATH; non-allowlisted gh subcommands refused" "$E2E_RUN_DIR/shim.txt" \
  || rec session.connect FAIL "rc=$rc $(tail -c 300 "$E2E_RUN_DIR/connect.json") / $(tr '\n' ' ' <<<"$shim" | head -c 300)" "$E2E_RUN_DIR/connect.json"

creds=$(sbx "$S_ID" 120 <<'SH'
grep -rlE 'ghs_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}' \
  ~ /etc /tmp 2>/dev/null | grep -vE '/node_modules/|\.(js|map|ts)$' | head; true
SH
)
creds="$creds$(key_copies "$S_ID")"
[ -z "$creds" ] && rec session.no-write-credential PASS "no GitHub token (ghs_/github_pat_/ghp_/gho_) in ~, /etc, /tmp and no copy of the App key anywhere in the Session" \
  || rec session.no-write-credential FAIL "credential files: $creds"

# ================================================================ tailnet ACL: the Session can reach the coordinator, not agentbox
say "tailnet ACL"
acl=$(sbx "$S_ID" 120 <<SH
c=\$(curl -s -o /dev/null -m 8 -w '%{http_code}' $C_URL/health); echo "coordinator=\$c"
for port in 443 22 42137; do r=\$(curl -s -o /dev/null -m 6 -w '%{http_code}' http://$AGENTBOX_TS_IP:\$port/ 2>/dev/null); echo "agentbox:\$port=\$r"; done
tailscale status 2>/dev/null | head -20
SH
)
printf '%s\n' "$acl" | ev tailnet-acl.txt >/dev/null
grep -qE '^coordinator=(200|401|404)$' <<<"$acl" && ! grep -qE '^agentbox:[0-9]+=[1-9]' <<<"$acl" \
  && rec acl.session-to-agentbox-blocked PASS "from the Session: coordinator reachable ($(grep ^coordinator= <<<"$acl")); agentbox $AGENTBOX_TS_IP unreachable on 443/22/42137 (tag:rp-session policy)" "$E2E_RUN_DIR/tailnet-acl.txt" \
  || rec acl.session-to-agentbox-blocked FAIL "$(tr '\n' ' ' <<<"$acl" | head -c 300)" "$E2E_RUN_DIR/tailnet-acl.txt"

# ================================================================ the real agent (no client of ours attached while it works)
AGENT_OK=""
if [ "${E2E_CLAUDE:-1}" = 1 ]; then
  say "agent: Claude in the Session"
  PAIR=$(jget 'd["meta"].get("pairingPath") or ""' < "$rec_file")
  pane=$(rpc --host "$HOST" panes create --repo app --name p3-agent --agent claude --no-focus --wait-ready --ready-timeout-ms 120000 --yes --json 2>&1)
  printf '%s\n' "$pane" | ev agent-pane.json >/dev/null
  A_PANEL=$(jget '((d.get("items") or [{}])[0]).get("panelId") or ""' <<<"$pane" 2>/dev/null)
  TASK="$E2E_RUN_DIR/agent-task.txt"
  cat > "$TASK" <<EOF
You are working in /home/user/app, a clone of the GitHub repo $REPO. You have no GitHub credentials; this cloud
Session reaches GitHub only through its coordinator, with \`runpane cloud agent github ...\` and the \`gh\` command.
Do exactly this, then stop:
1. Create a branch named p3-agent-proof. Add the file notes/p3-proof.md containing one line: "written by a cloud agent".
   Commit it with the message "p3: agent proof".
2. Push it: \`runpane cloud agent github push --path /home/user/app --branch p3-agent-proof\`. Note the ref and compare URL it prints.
3. Open a GitHub issue: \`gh issue create --title "[runpane-cloud TEST] agent proof issue" --body "Opened by the P3 gate agent."\`.
4. Open a DRAFT pull request from that branch: \`gh pr create --draft --title "[runpane-cloud TEST] agent proof PR" --body "Refs the proof issue." --head p3-agent-proof\`.
5. Comment on the issue with the PR's URL: \`gh issue comment <issue-number> --body "PR: <url>"\`.
Do not try to push to master or merge anything. When done, reply with exactly one line:
RESULT issue=<issue-number> pr=<pr-number> ref=<pushed ref>
EOF
  if [ -n "$A_PANEL" ]; then
    rpc --host "$HOST" panels submit --panel "$A_PANEL" --input-file "$TASK" --yes --json > "$E2E_RUN_DIR/agent-submit.json" 2>&1
    T_SUBMIT=$(ms_now); log "task submitted at $(date -u +%T); detached: from now on the harness only uses the boat exec API (not the tailnet)"
    # prove the detach: no TCP flow between agentbox and the Session's tailnet address, sampled every ~20 s
    S_TS_IP=$(sbx "$S_ID" 30 <<<'tailscale ip -4 | head -1' | tail -1)
    : > "$E2E_RUN_DIR/agent-window-sockets.txt"; flows_agentbox=0
    end=$(( $(date +%s) + ${E2E_AGENT_TIMEOUT:-900} )); state=""
    while [ "$(date +%s)" -lt "$end" ]; do
      a=$(ss -Htn "dst $S_TS_IP" 2>/dev/null | wc -l)
      s=$(sbx "$S_ID" 60 <<SH
echo "t=\$(date -u +%T) sockets:"; ss -Htn state established | awk '{print \$3" -> "\$4}' | sort | uniq -c | sort -rn | head -12
SH
)
      { echo "agentbox->session established: $a"; printf '%s\n' "$s"; } >> "$E2E_RUN_DIR/agent-window-sockets.txt"
      grep -qF "$AGENTBOX_TS_IP" <<<"$s" && flows_agentbox=$((flows_agentbox+1)); [ "$a" -gt 0 ] && flows_agentbox=$((flows_agentbox+1))
      state=$(fake_admin "$C_ID" GET /_fake/state)
      python3 - "$state" "$REPO" <<'PY' && break
import json, sys
st = json.loads(sys.argv[1]); r = st["repos"][sys.argv[2]]
pulls = [i for i in r["issues"] if i["pull"] and (i["head"] or {}).get("ref", "").endswith("/p3-agent-proof")]
issues = [i for i in r["issues"] if not i["pull"] and i["title"].startswith("[runpane-cloud TEST]")]
sys.exit(0 if pulls and issues and any(i["comments"] for i in issues) else 1)
PY
      sleep 20
    done
    agent_s=$(secs_since "$T_SUBMIT")
    printf '%s\n' "$state" | ev fake-state-after-agent.json >/dev/null
    v=$(python3 - "$state" "$REPO" "$PFX" <<'PY'
import json, sys
st = json.loads(sys.argv[1]); r = st["repos"][sys.argv[2]]; pfx = sys.argv[3]
pulls = [i for i in r["issues"] if i["pull"] and (i["head"] or {}).get("ref") == pfx + "p3-agent-proof"]
issues = [i for i in r["issues"] if not i["pull"] and i["title"].startswith("[runpane-cloud TEST]")]
ref = r["refs"].get("refs/heads/" + pfx + "p3-agent-proof")
p = pulls[0] if pulls else {}
print(json.dumps({"ref": ref, "pr": p.get("number"), "draft": p.get("draft"), "prMarker": p.get("marker"), "prUser": p.get("user"),
                  "issue": issues[0]["number"] if issues else None, "issueMarker": issues[0]["marker"] if issues else None,
                  "issueComments": issues[0]["comments"] if issues else None, "master": r["refs"].get("refs/heads/master")}))
PY
)
    printf '%s\n' "$v" | ev agent-result.json >/dev/null
    if [ "$(jget 'bool(d["ref"] and d["pr"] and d["draft"] is True and d["issue"] and d["issueComments"])' <<<"$v")" = true ]; then
      AGENT_OK=1
      rec agent.pr-issue-push PASS "real Claude in $HOST: pushed $(jget 'd["ref"][:10]' <<<"$v") to ${PFX}p3-agent-proof, draft PR #$(jget 'd["pr"]' <<<"$v") (author $(jget 'd["prUser"]' <<<"$v"), marker $(jget 'd["prMarker"]' <<<"$v")), issue #$(jget 'd["issue"]' <<<"$v") + comment, in ${agent_s}s" "$E2E_RUN_DIR/agent-result.json" "seconds=$agent_s"
    else
      rec agent.pr-issue-push FAIL "after ${agent_s}s: $v" "$E2E_RUN_DIR/agent-result.json"
    fi
    [ "$(jget 'd["master"]' <<<"$v")" = "$MASTER0" ] && rec agent.master-untouched PASS "fake master still $MASTER0 after the agent" || rec agent.master-untouched FAIL "master moved: $(jget 'd["master"]' <<<"$v")"
    [ "$flows_agentbox" = 0 ] && rec agent.no-agentbox-in-path PASS "no agentbox<->Session TCP flow in any sample of the agent window (agentbox ss + Session ss; harness used boat exec only)" "$E2E_RUN_DIR/agent-window-sockets.txt" \
      || rec agent.no-agentbox-in-path FAIL "$flows_agentbox samples showed an agentbox<->Session flow" "$E2E_RUN_DIR/agent-window-sockets.txt"
    # the agent's own words (after the fact; this is a tailnet read, outside the window)
    rpc --host "$HOST" panels last-message --panel "$A_PANEL" --json > "$E2E_RUN_DIR/agent-last-message.json" 2>&1 || true
  else rec agent.pr-issue-push FAIL "agent pane not created" "$E2E_RUN_DIR/agent-pane.json"; fi
else rec agent.pr-issue-push SKIP "E2E_CLAUDE=0"; fi

# ================================================================ gh-compat: Pane's own gh call sites, run as the daemon runs gh
if [ -n "$AGENT_OK" ]; then
  say "gh-compat call sites"
  PR_N=$(jget 'd["pr"]' < "$E2E_RUN_DIR/agent-result.json"); HEAD_SHA=$(jget 'd["ref"]' < "$E2E_RUN_DIR/agent-result.json")
  fake_admin "$C_ID" POST /_fake/seed/check "{\"repo\":\"$REPO\",\"sha\":\"$HEAD_SHA\",\"name\":\"rp-e2e-ci\",\"conclusion\":\"success\"}" | ev seed-check.json >/dev/null
  gc=$(sbx "$S_ID" 180 <<SH
cd /home/user/app
export PATH=/usr/local/bin:/home/user/.local/bin:/usr/bin:/bin   # non-interactive, minimal PATH (like the daemon's gh spawns)
echo "gh=\$(command -v gh) usr-local-link=\$(readlink /usr/local/bin/gh 2>/dev/null)"
gh pr list --head p3-agent-proof --state all --json number,url,title,state,isDraft,body --limit 1 > /home/user/rcl/gh-list.json 2>/home/user/rcl/gh-list.err; echo "list exit=\$?"
gh pr view $PR_N --json number,url,state,mergeable,statusCheckRollup,headRefOid > /home/user/rcl/gh-view.json 2>/home/user/rcl/gh-view.err; echo "view exit=\$?"
cat /home/user/rcl/gh-list.err /home/user/rcl/gh-view.err
SH
)
  printf '%s\n' "$gc" | ev gh-compat.txt >/dev/null
  cl boat fetch "$S_ID" /home/user/rcl/gh-list.json "$E2E_RUN_DIR/gh-pr-list.json" >/dev/null
  cl boat fetch "$S_ID" /home/user/rcl/gh-view.json "$E2E_RUN_DIR/gh-pr-view.json" >/dev/null
  v=$(python3 - "$E2E_RUN_DIR/gh-pr-list.json" "$PR_N" <<'PY'
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception as e: print(f"unparsable: {e}"); sys.exit(1)
it = d[0] if isinstance(d, list) and len(d) == 1 else None
ok = bool(it) and it["number"] == int(sys.argv[2]) and it["isDraft"] is True and it["state"] == "OPEN" \
     and it["url"].endswith(f"/pull/{sys.argv[2]}") and it["title"].startswith("[runpane-cloud TEST]") and "runpane-cloud:" in it["body"]
print(json.dumps({k: it.get(k) for k in ("number", "state", "isDraft", "url", "title")}) if it else json.dumps(d)[:300]); sys.exit(0 if ok else 1)
PY
) && rec gh-compat.pr-list PASS "gh pr list --head p3-agent-proof --state all --json ... --limit 1 -> $v" "$E2E_RUN_DIR/gh-pr-list.json" \
    || rec gh-compat.pr-list FAIL "$v / $(tr '\n' ' ' <<<"$gc" | head -c 300)" "$E2E_RUN_DIR/gh-compat.txt"
  v=$(python3 - "$E2E_RUN_DIR/gh-pr-view.json" "$PR_N" "$HEAD_SHA" <<'PY'
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception as e: print(f"unparsable: {e}"); sys.exit(1)
roll = d.get("statusCheckRollup") or []
check = [c for c in roll if (c.get("name") or c.get("context")) == "rp-e2e-ci" and str(c.get("conclusion") or c.get("state")).upper() == "SUCCESS"]
ok = d.get("number") == int(sys.argv[2]) and d.get("state") == "OPEN" and d.get("headRefOid") == sys.argv[3] \
     and d.get("mergeable") == "MERGEABLE" and bool(check) and d.get("url", "").endswith(f"/pull/{sys.argv[2]}")
print(json.dumps({"number": d.get("number"), "state": d.get("state"), "mergeable": d.get("mergeable"),
                  "headRefOid": (d.get("headRefOid") or "")[:10], "statusCheckRollup": roll})[:400]); sys.exit(0 if ok else 1)
PY
) && rec gh-compat.pr-view PASS "gh pr view $PR_N --json number,url,state,mergeable,statusCheckRollup,headRefOid -> $v" "$E2E_RUN_DIR/gh-pr-view.json" \
    || rec gh-compat.pr-view FAIL "$v / $(tr '\n' ' ' <<<"$gc" | head -c 300)" "$E2E_RUN_DIR/gh-compat.txt"
else rec gh-compat SKIP "no agent PR to look at"; fi

# ================================================================ refusals, probed live from inside the Session
say "refusals"
bcall_install "$S_ID" | ev bcall-install.txt >/dev/null
fake_admin "$C_ID" GET /_fake/log | wc -l > "$E2E_RUN_DIR/.fake-log-mark"
code_of() { awk '{print $1}' <<<"$1"; }
errc_of() { python3 -c 'import json,sys;t=sys.argv[1].split(" ",1);print((json.loads(t[1]) if len(t)>1 else {}).get("code",""))' "$1" 2>/dev/null; }
probe() {  # probe <check> <expect-http-regex> <expect-code-regex> <METHOD> <path> [json]
  local c="$1" wantc="$2" wante="$3"; shift 3
  local r; r=$(bcall "$S_ID" "$@"); printf '%s %s -> %s\n' "$1" "$2" "$r" >> "$E2E_RUN_DIR/refusals.txt"
  local hc ec; hc=$(code_of "$r"); ec=$(errc_of "$r")
  [[ "$hc" =~ ^($wantc)$ ]] && [[ "$ec" =~ ^($wante)$ ]] && rec "refuse.$c" PASS "$1 $2 -> $hc ${ec:-}" "$E2E_RUN_DIR/refusals.txt" \
    || rec "refuse.$c" FAIL "$1 $2 -> $(head -c 240 <<<"$r")" "$E2E_RUN_DIR/refusals.txt"
}
# a real bundle to carry in the probes (a commit on top of origin/master)
sbx "$S_ID" 120 <<'SH' >/dev/null
cd /home/user/app && git checkout -q -B probe origin/master && echo probe > probe.txt && git add probe.txt && git -c user.name=p -c user.email=p@x commit -qm probe
git checkout -q -B wf origin/master && echo "# changed" >> .github/workflows/ci.yml && git -c user.name=p -c user.email=p@x commit -qam "touch workflow"
git checkout -q master
SH
B64=$(bundle_file "$S_ID" /home/user/app /home/user/rcl/probe.b64 probe --not origin/master | tail -1 | awk '{print $1}')
WF64=$(bundle_file "$S_ID" /home/user/app /home/user/rcl/wf.b64 wf --not origin/master | tail -1 | awk '{print $1}')
pprobe() {  # pprobe <check> <http> <code> <repo> <branch> <bundle-b64-file> [extra-json]
  local c="$1" h="$2" e="$3" q; q=$(printf '%q ' "$4" "$5" "$6" "${7:-}")
  local r; r=$(sbx "$S_ID" 120 <<<"/home/user/rcl/pushprobe $q" | tail -1)
  printf 'POST /cloud/github/push repo=%s branch=%s %s -> %s\n' "$4" "$5" "${7:-}" "$r" >> "$E2E_RUN_DIR/refusals.txt"
  local hc ec; hc=$(code_of "$r"); ec=$(errc_of "$r")
  [[ "$hc" =~ ^($h)$ ]] && [[ "$ec" =~ ^($e)$ ]] && rec "refuse.$c" PASS "push branch='$5' repo=$4 ${7:-} -> $hc ${ec:-}" "$E2E_RUN_DIR/refusals.txt" \
    || rec "refuse.$c" FAIL "push branch='$5' repo=$4 -> $(head -c 240 <<<"$r")" "$E2E_RUN_DIR/refusals.txt"
}
# master / namespace escapes (the broker picks the target ref; these try to steer it)
pprobe master-short         '403' 'ref-outside-namespace' "$REPO" "master" "$B64"
pprobe main-short           '403' 'ref-outside-namespace' "$REPO" "main" "$B64"
pprobe master-dotdot        '400|403' '.*' "$REPO" "../../master" "$B64"
pprobe master-leading-slash '400|403' '.*' "$REPO" "/master" "$B64"
pprobe master-refs-path     '400|403|200|201' '.*' "$REPO" "refs/heads/master" "$B64"   # lands (if at all) under the prefix; master checked below
pprobe namespace-other-host '400|403' '.*' "$REPO" "../$HOST-other/x" "$B64"
pprobe branch-too-long      '400|403' '.*' "$REPO" "$(printf 'b%.0s' $(seq 101))" "$B64"
pprobe branch-empty         '400|403' '.*' "$REPO" "" "$B64"
pprobe workflow-change      '403' 'workflow-change-refused' "$REPO" "wf-probe" "$WF64"
pprobe repo-not-allowed     '403' 'repo-not-allowed' "$OTHER" "x" "$B64"
pprobe force-outside        '400|403' '.*' "$REPO" "../../master" "$B64" '{"force":true}'
M_NOW=$(fake_master "$C_ID" "$REPO")
[ "$M_NOW" = "$MASTER0" ] && rec refuse.master-unchanged PASS "fake master still $MASTER0 after every push probe" || rec refuse.master-unchanged FAIL "master moved to $M_NOW"
refs=$(sbx "$C_ID" 60 <<<"git --git-dir=$FAKE_DIR/state/git/$REPO.git for-each-ref --format='%(refname)' refs/heads/")
printf '%s\n' "$refs" | ev fake-refs-after-probes.txt >/dev/null
bad_refs=$(grep -vE "^refs/heads/(master|${PFX//\//\\/}.*|cloud/other-host/.*)$" <<<"$refs")
[ -z "$bad_refs" ] && rec refuse.refs-only-in-prefix PASS "every branch in the fake is master or under $PFX: $(tr '\n' ' ' <<<"$refs")" "$E2E_RUN_DIR/fake-refs-after-probes.txt" \
  || rec refuse.refs-only-in-prefix FAIL "refs outside the namespace: $bad_refs" "$E2E_RUN_DIR/fake-refs-after-probes.txt"
grep -q "wf-probe" <<<"$refs" && rec refuse.workflow-not-pushed FAIL "the workflow-change branch reached the fake" || rec refuse.workflow-not-pushed PASS "no wf-probe ref in the fake: the broker refused before any git push"

# merge, ready-for-review, another Session's PR / issue, repo outside the allowlist, user-only endpoints
fake_admin "$C_ID" POST /_fake/seed/pull "{\"repo\":\"$REPO\",\"head\":\"cloud/other-host/theirs\",\"title\":\"another Session's PR\",\"body\":\"x\\n<!-- runpane-cloud:other-session -->\"}" | ev seed-pull.json >/dev/null
fake_admin "$C_ID" POST /_fake/seed/issue "{\"repo\":\"$REPO\",\"title\":\"another Session's issue\",\"body\":\"x\\n<!-- runpane-cloud:other-session -->\"}" | ev seed-issue.json >/dev/null
THEIR_PR=$(jget 'd["number"]' < "$E2E_RUN_DIR/seed-pull.json"); THEIR_ISSUE=$(jget 'd["number"]' < "$E2E_RUN_DIR/seed-issue.json")
MY_PR=$( [ -n "$AGENT_OK" ] && jget 'd["pr"]' < "$E2E_RUN_DIR/agent-result.json" || echo 1)
probe merge-put            '403|404|405' '.*' PUT "/cloud/github/pulls/$MY_PR/merge" '{}'
probe merge-post           '403|404|405' '.*' POST "/cloud/github/pulls/$MY_PR/merge" '{}'
probe ready-for-review     '400|403'     '.*' PATCH "/cloud/github/pulls/$MY_PR" "{\"repo\":\"$REPO\",\"draft\":false}"
probe merged-state         '400|403'     '.*' PATCH "/cloud/github/pulls/$MY_PR" "{\"repo\":\"$REPO\",\"state\":\"merged\"}"
probe other-pr-edit        '403'         'not-owner' PATCH "/cloud/github/pulls/$THEIR_PR" "{\"repo\":\"$REPO\",\"title\":\"hijacked\"}"
probe other-pr-close       '403'         'not-owner' PATCH "/cloud/github/pulls/$THEIR_PR" "{\"repo\":\"$REPO\",\"state\":\"closed\"}"
probe other-issue-edit     '403'         'not-owner' PATCH "/cloud/github/issues/$THEIR_ISSUE" "{\"repo\":\"$REPO\",\"body\":\"hijacked\"}"
probe other-issue-close    '403'         'not-owner' PATCH "/cloud/github/issues/$THEIR_ISSUE" "{\"repo\":\"$REPO\",\"state\":\"closed\"}"
probe pr-head-dotdot       '400|403'     '.*' POST /cloud/github/pulls "{\"repo\":\"$REPO\",\"branch\":\"../other-host/theirs\",\"title\":\"x\",\"body\":\"x\"}"
probe pr-head-other-full   '400|403|502' '.*' POST /cloud/github/pulls "{\"repo\":\"$REPO\",\"branch\":\"cloud/other-host/theirs\",\"title\":\"x\",\"body\":\"x\"}"
probe issue-other-repo     '403'         'repo-not-allowed' POST /cloud/github/issues "{\"repo\":\"$OTHER\",\"title\":\"x\",\"body\":\"x\"}"
probe read-not-allowlisted '400|403|404' '.*' GET "/cloud/github/read/$REPO/collaborators"
probe read-other-repo      '403'         'repo-not-allowed' GET "/cloud/github/read/$OTHER/issues"
probe audit-peer           '403'         '.*' GET /cloud/github/audit
probe unknown-endpoint     '403|404'     '.*' POST /cloud/github/releases "{\"repo\":\"$REPO\"}"
shimm=$(sbx "$S_ID" 60 <<'SH'
export PATH="$HOME/.local/bin:$PATH"; cd /home/user/app
gh pr merge 1 --merge 2>&1 | head -2; echo "exit=${PIPESTATUS[0]}"; gh pr ready 1 2>&1 | head -1; echo "exit=${PIPESTATUS[0]}"
git push origin HEAD:master 2>&1 | tail -2; echo "gitexit=${PIPESTATUS[0]}"
SH
)
printf '%s\n' "$shimm" | ev shim-refusals.txt >/dev/null
[ "$(grep -c '^exit=2$' <<<"$shimm")" = 2 ] && grep -qE '^gitexit=[1-9]' <<<"$shimm" \
  && rec refuse.shim-merge-and-direct-push PASS "gh pr merge / gh pr ready exit 2 (broker allowlist); plain git push to master fails (no credential in the Session)" "$E2E_RUN_DIR/shim-refusals.txt" \
  || rec refuse.shim-merge-and-direct-push FAIL "$(tr '\n' ' ' <<<"$shimm" | head -c 300)" "$E2E_RUN_DIR/shim-refusals.txt"
st=$(fake_admin "$C_ID" GET /_fake/state); printf '%s\n' "$st" | ev fake-state-final.json >/dev/null
python3 - "$st" "$REPO" "$THEIR_PR" "$THEIR_ISSUE" <<'PY' && rec refuse.github-state-intact PASS "in the fake: every PR still draft and unmerged; another Session's PR/issue unchanged" "$E2E_RUN_DIR/fake-state-final.json" || rec refuse.github-state-intact FAIL "fake state changed" "$E2E_RUN_DIR/fake-state-final.json"
import json, sys
r = json.loads(sys.argv[1])["repos"][sys.argv[2]]
by = {i["number"]: i for i in r["issues"]}
ok = all(i["draft"] and not i["merged"] for i in r["issues"] if i["pull"])
ok &= by[int(sys.argv[3])]["title"] == "another Session's PR" and by[int(sys.argv[3])]["state"] == "open"
ok &= by[int(sys.argv[4])]["state"] == "open"
ok &= sum(1 for i in r["issues"] if i["pull"] and (i["head"] or {}).get("ref") == "cloud/other-host/theirs") == 1  # no PR of ours on their head
sys.exit(0 if ok else 1)
PY

# ---- the Session's peer token used from other nodes (copied through 0600 files; never printed)
say "token from another node"
cl boat fetch "$S_ID" /home/user/.config/runpane-cloud/peers.json "$E2E_SECRETS/session-peers.json"
python3 -c 'import json,sys;open(sys.argv[2],"w").write(json.load(open(sys.argv[1]))["coordinator"]["token"])' "$E2E_SECRETS/session-peers.json" "$E2E_SECRETS/session.tok"
chmod 600 "$E2E_SECRETS/session.tok" "$E2E_SECRETS/session-peers.json"
body="{\"repo\":\"$REPO\",\"title\":\"stolen token\",\"body\":\"x\"}"
h1=$(curl -s -o "$E2E_RUN_DIR/stolen-agentbox.json" -w '%{http_code}' -m 20 -X POST -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$E2E_SECRETS/session.tok")") \
  -H 'Content-Type: application/json' --data "$body" "$C_URL/cloud/github/issues")
cl boat put "$C_ID" "$E2E_SECRETS/session.tok" rcl/stolen.tok >/dev/null
h2=$(sbx "$C_ID" 60 <<SH | tail -1
chmod 600 /home/user/rcl/stolen.tok
curl -s -o /home/user/rcl/stolen.json -w '%{http_code}' -m 20 -X POST -H "Authorization: Bearer \$(cat /home/user/rcl/stolen.tok)" -H 'Content-Type: application/json' --data '$body' $C_URL/cloud/github/issues
shred -u /home/user/rcl/stolen.tok
SH
)
sbx "$C_ID" 30 <<<'cat /home/user/rcl/stolen.json' | ev stolen-coordinator-node.json >/dev/null
[[ "$h1" =~ ^(401|403)$ ]] && rec refuse.token-from-agentbox PASS "the Session's peer token used from agentbox (tailnet member) -> $h1 $(jget 'd.get("code","")' < "$E2E_RUN_DIR/stolen-agentbox.json" 2>/dev/null)" "$E2E_RUN_DIR/stolen-agentbox.json" \
  || rec refuse.token-from-agentbox FAIL "-> $h1" "$E2E_RUN_DIR/stolen-agentbox.json"
[[ "$h2" =~ ^(401|403)$ ]] && rec refuse.token-from-other-rp-session-node PASS "the same token used from another tag:rp-session node ($C_HOST) -> $h2 $(jget 'd.get("code","")' < "$E2E_RUN_DIR/stolen-coordinator-node.json" 2>/dev/null)" "$E2E_RUN_DIR/stolen-coordinator-node.json" \
  || rec refuse.token-from-other-rp-session-node FAIL "-> $h2" "$E2E_RUN_DIR/stolen-coordinator-node.json"
shred -u "$E2E_SECRETS/session.tok" "$E2E_SECRETS/session-peers.json"

# ---- read-only token for fetch (App mode): exactly contents:read on one repo
r=$(bcall "$S_ID" POST /cloud/github/token "{\"repo\":\"$REPO\"}")
printf '%s\n' "$(code_of "$r") $(errc_of "$r")" | ev read-token.txt >/dev/null   # status only: the body holds a token
st=$(fake_admin "$C_ID" GET /_fake/state)
python3 - "$st" "$REPO" <<'PY' > "$E2E_RUN_DIR/minted-tokens.json"
import json, sys
toks = json.loads(sys.argv[1])["tokens"]
print(json.dumps([{k: t[k] for k in ("repos", "permissions", "issued")} for t in toks], indent=1))
PY
ro=$(python3 -c 'import json,sys;t=json.load(open(sys.argv[1]));print(sum(1 for x in t if x["permissions"]=={"contents":"read","metadata":"read"} and x["repos"]==[sys.argv[2]]))' "$E2E_RUN_DIR/minted-tokens.json" "$REPO")
wide=$(python3 -c 'import json,sys;t=json.load(open(sys.argv[1]));print(sum(1 for x in t if len(x["repos"])!=1 and set(x["permissions"])-{"metadata"}))' "$E2E_RUN_DIR/minted-tokens.json")
[ "$(code_of "$r")" = 200 ] && [ "$ro" -ge 1 ] && rec broker.read-token PASS "POST /cloud/github/token -> 200; the fake minted it as contents:read+metadata:read on $REPO only" "$E2E_RUN_DIR/minted-tokens.json" \
  || rec broker.read-token FAIL "HTTP $(code_of "$r") $(errc_of "$r"); read-only tokens minted: $ro" "$E2E_RUN_DIR/minted-tokens.json"
[ "$wide" = 0 ] && rec broker.tokens-downscoped PASS "every installation token with more than metadata:read names exactly one repository ($(jget 'len(d)' < "$E2E_RUN_DIR/minted-tokens.json") tokens)" "$E2E_RUN_DIR/minted-tokens.json" \
  || rec broker.tokens-downscoped FAIL "$wide token(s) not limited to one repo" "$E2E_RUN_DIR/minted-tokens.json"

# ================================================================ evidence: the fake's log and the coordinator's audit
say "evidence"
fake_admin "$C_ID" GET /_fake/log > "$E2E_RUN_DIR/fake-requests.jsonl"
python3 - "$E2E_RUN_DIR/fake-requests.jsonl" > "$E2E_RUN_DIR/fake-requests-summary.txt" <<'PY'
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
c = collections.Counter((r.get("remote"), r.get("auth")) for r in rows)
print("requests:", len(rows)); print("by (remote, auth):", dict(c))
print("merge calls:", sum(1 for r in rows if r.get("merge"))); print("graphql/unmodelled:", sum(1 for r in rows if r.get("unmodelled")))
print("pushes:", [u["ref"] for r in rows for x in (r.get("receive") or []) for u in x["updates"]])
print("labelsCreated:", [r["labelsCreated"] for r in rows if r.get("labelsCreated")])
PY
remotes=$(python3 -c 'import json,sys;print(sorted({json.loads(l).get("remote") for l in open(sys.argv[1]) if l.strip()}))' "$E2E_RUN_DIR/fake-requests.jsonl")
merges=$(python3 -c 'import json,sys;print(sum(1 for l in open(sys.argv[1]) if l.strip() and json.loads(l).get("merge")))' "$E2E_RUN_DIR/fake-requests.jsonl")
[ "$remotes" = "['127.0.0.1']" ] && rec evidence.fake-only-from-coordinator PASS "every request the fake GitHub saw came from the coordinator itself (127.0.0.1)" "$E2E_RUN_DIR/fake-requests-summary.txt" \
  || rec evidence.fake-only-from-coordinator FAIL "remotes: $remotes" "$E2E_RUN_DIR/fake-requests-summary.txt"
[ "$merges" = 0 ] && rec evidence.no-merge-reached-github PASS "0 merge calls reached GitHub" "$E2E_RUN_DIR/fake-requests-summary.txt" || rec evidence.no-merge-reached-github FAIL "$merges merge call(s) reached the fake"
broker_audit > "$E2E_RUN_DIR/coordinator-github-audit.json" 2>&1
am=$(sbx "$C_ID" 30 <<<'stat -c %a ~/.config/runpane-cloud-coordinator/state/github-audit.jsonl 2>/dev/null || find ~ -name github-audit.jsonl -printf "%m %p\n"')
python3 - "$E2E_RUN_DIR/coordinator-github-audit.json" "$HOST" > "$E2E_RUN_DIR/audit-summary.txt" <<'PY'
import json, sys, collections
raw = open(sys.argv[1]).read()
try:
    d = json.loads(raw); rows = d if isinstance(d, list) else (d.get("entries") or d.get("audit") or d.get("lines") or [])
except json.JSONDecodeError:
    rows = [json.loads(l) for l in raw.splitlines() if l.strip().startswith("{")]
print("audit lines:", len(rows))
print("callers:", dict(collections.Counter(r.get("callerId") for r in rows)))
print("nodes:", dict(collections.Counter(r.get("node") for r in rows)))
print("outcomes:", dict(collections.Counter((r.get("endpoint"), r.get("outcome") or r.get("code")) for r in rows)))
PY
leak=$(grep -cE 'ghs_[A-Za-z0-9]{20,}|rpc1\.[^" ]+\.[A-Za-z0-9_-]{20,}|BEGIN (RSA )?PRIVATE' "$E2E_RUN_DIR/coordinator-github-audit.json")
grep -q "$HOST" "$E2E_RUN_DIR/audit-summary.txt" && grep -qE 'workflow-change-refused' "$E2E_RUN_DIR/coordinator-github-audit.json" && grep -qE 'not-owner' "$E2E_RUN_DIR/coordinator-github-audit.json" \
  && [ "$leak" = 0 ] && [ "$(tail -1 <<<"$am" | awk '{print $1}')" = 600 ] \
  && rec evidence.audit PASS "coordinator audit: $(sed -n 1p "$E2E_RUN_DIR/audit-summary.txt"); refusals logged with the Session's callerId/node; 0600; no token in it" "$E2E_RUN_DIR/audit-summary.txt" \
  || rec evidence.audit FAIL "audit check (mode=$(tail -1 <<<"$am"), token-like strings=$leak): $(tr '\n' ' ' < "$E2E_RUN_DIR/audit-summary.txt" | head -c 300)" "$E2E_RUN_DIR/coordinator-github-audit.json"

# ================================================================ teardown through the product (then e2e_cleanup sweeps the rest)
if [ "${KEEP:-0}" != 1 ]; then
  say "teardown"
  rpc cloud destroy "$HOST" --yes --json > "$E2E_RUN_DIR/destroy-session.json" 2>&1 || log "WARN cloud destroy $HOST failed"
  rpc cloud coordinator destroy --yes --json > "$E2E_RUN_DIR/destroy-coordinator.json" 2>&1 || log "WARN coordinator destroy failed"
fi
