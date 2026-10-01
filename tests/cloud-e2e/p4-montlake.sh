#!/usr/bin/env bash
# P4 (phase3-design §9): the broker against REAL GitHub (jamari-morrison/montlakev2), one command.
#
#   tests/cloud-e2e/p4-montlake.sh <credential-file> <host> [options]
#
# <credential-file>  a GitHub App private key (.pem; pass --app-id / --app-id-file) or a fine-grained PAT file
#                    (github_pat_…; classic ghp_/gho_/… tokens are refused). Red-created, BYOK.
# <host>             the cloud Session (e.g. rp-red-zd56pin5) whose coordinator gets the credential.
#
# SAFETY RULES (this runs against a real repository without branch protection):
#   * The run only ever touches what it CREATED (recorded in created.jsonl with the sha/number at creation) or what the
#     operator ADOPTED explicitly (--adopt-issue N, --adopt-pr N, --adopt-branch NAME@SHA: leftovers of an earlier
#     failed run; adopted only if they look like ours: "[runpane-cloud" title + a [bot] author or the broker's
#     <!-- runpane-cloud: --> marker; a branch only with its exact sha).
#   * Refs that already exist under cloud/<host>/ at preflight are recorded and never touched. A NEW ref that isn't ours
#     is a FAIL and is reported, never deleted. A branch is deleted only if it still points at the recorded sha.
#   * --keep-branch: no ref is deleted at all.  --keep-open: nothing is closed.
#   * Every GitHub call's HTTP status is checked; a failed call is a FAIL, never silent. Final checks re-read GitHub.
#   * Writes on agentbox use only the user's App/PAT credential (cleanup); agentbox's classic gh token is read-only here.
#
# Steps (evidence in ~/rc-loop/evidence/p3-e2e/p4-<utc>/):
#   0. preflight (read-only): master == --expect-master; refs under cloud/<host>/ recorded; adopted items validated;
#      the Session is awake. --dry-run stops here and prints exactly what cleanup would touch.
#   1. `cloud coordinator github set` (in place; --redeploy first runs `coordinator deploy --yes`), `github connect --broker`
#   2. keepalive: `rpc --host <host> panels list` every 60 s (a user /invoke within 15 min blocks idle-stop), so the
#      coordinator can't stop the Session mid-run; every Session step first checks the Session is running (FAIL if not;
#      --wake-if-asleep wakes it through `cloud wake` instead, which costs a start on the Session's wallet)
#   3. in the Session: branch from origin/master (+1 file), broker push to cloud/<host>/<branch>, issue + DRAFT PR titled
#      "[runpane-cloud TEST] …" (script mode over boat exec, or --mode agent: a Claude panel; the wait ends as soon as
#      its last message has a RESULT line), then the refusals
#   4. verify on GitHub; 5. cleanup (EXIT trap) + final re-read checks. Exit 0 only if every check passed.
#
# Options: --app-id N | --app-id-file F   --installation-id N   --repo owner/name (jamari-morrison/montlakev2)
#          --expect-master SHA (78086cb3)  --rpc CMD (~/.local/bin/rpc)  --path DIR (the clone in the Session; auto)
#          --branch NAME (p3-proof)        --mode script|agent (script)  --agent-timeout S (900)
#          --adopt-issue N  --adopt-pr N  --adopt-branch NAME@SHA  (repeatable)
#          --redeploy  --skip-set  --keep-open  --keep-branch  --wake-if-asleep  --dry-run
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; LIB="$HERE/lib"
. "$LIB/broker.sh"
cl() { python3 "$LIB/cloudlab.py" "$@"; }

[ $# -ge 2 ] || { sed -n 2,40p "$0"; exit 2; }
CRED="$1"; HOST="$2"; shift 2
REPO=jamari-morrison/montlakev2; EXPECT=78086cb3; RPC="$HOME/.local/bin/rpc"; APP_ID=""; INST=""; SPATH=""
MODE=script; REDEPLOY=0; SKIP_SET=0; KEEP_OPEN=0; KEEP_BRANCH=0; DRY=0; BR=p3-proof; AGENT_TIMEOUT=900; WAKE=0
ADOPT_ISSUES=(); ADOPT_PRS=(); ADOPT_BRANCHES=()
while [ $# -gt 0 ]; do case "$1" in
  --app-id) APP_ID="$2"; shift 2;; --app-id-file) APP_ID=$(tr -d ' \r\n' < "$2"); shift 2;;
  --installation-id) INST="$2"; shift 2;; --repo) REPO="$2"; shift 2;; --expect-master) EXPECT="$2"; shift 2;;
  --rpc) RPC="$2"; shift 2;; --path) SPATH="$2"; shift 2;; --mode) MODE="$2"; shift 2;; --branch) BR="$2"; shift 2;;
  --agent-timeout) AGENT_TIMEOUT="$2"; shift 2;;
  --adopt-issue) ADOPT_ISSUES+=("$2"); shift 2;; --adopt-pr) ADOPT_PRS+=("$2"); shift 2;; --adopt-branch) ADOPT_BRANCHES+=("$2"); shift 2;;
  --redeploy) REDEPLOY=1; shift;; --skip-set) SKIP_SET=1; shift;; --keep-open) KEEP_OPEN=1; shift;;
  --keep-branch) KEEP_BRANCH=1; shift;; --wake-if-asleep) WAKE=1; shift;; --dry-run) DRY=1; shift;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
case "$MODE" in script|agent) ;; *) echo "--mode must be script or agent" >&2; exit 2;; esac

EV="${P4_EVIDENCE_DIR:-$HOME/rc-loop/evidence/p3-e2e/p4-$(date -u +%Y%m%dT%H%M%SZ)}"; mkdir -p "$EV"
SEC="$EV/.secrets"; (umask 077; mkdir -p "$SEC")
exec > >(tee -a "$EV/p4.log") 2>&1
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
RESULTS="$EV/results.txt"; : > "$RESULTS"; FAILS=0
rec() { printf '%-6s %-38s %s\n' "$2" "$1" "$3" | tee -a "$RESULTS"; [ "$2" = FAIL ] && FAILS=$((FAILS+1)); true; }
E2E_RUN_DIR="$EV"; E2E_SECRETS="$SEC"; E2E_LIB="$LIB"; export E2E_LIB
P4_API="${P4_API:-https://api.github.com}"   # test hook: the fake GitHub in p4-selftest.sh
sbx() { { echo 'export XDG_RUNTIME_DIR=/run/user/$(id -u) PATH="$HOME/.local/bin:$HOME/.pane_remote/bin:$PATH"'; cat; } | cl boat exec "$1" - --timeout "${2:-600}"; }
rpc() { env -u PANE_SESSION_ID -u PANE_PANEL_ID -u PANE_ORCHESTRATION_SESSION_ID $RPC "$@"; }
if [ "${P4_STUB_SESSION:-0}" = 1 ]; then  # test hook (p4-selftest.sh): no Session, no CLI; GitHub side is real (a fake)
  sbx() { cat >/dev/null; [ -n "${P4_STUB_SBX:-}" ] && bash -c "$P4_STUB_SBX"; true; }
  rpc() { echo '{}'; }
  cl() { case "$1 $2" in "boat get") echo running;; *) true;; esac; }
fi
PFX="cloud/$HOST/"; FULL="$PFX$BR"; OWNER="${REPO%%/*}"; NAME="${REPO##*/}"
TITLE_PREFIX="[runpane-cloud TEST]"
CREATED="$EV/created.jsonl"; : > "$CREATED"          # {"kind":"branch|issue|pr","id":<ref or number>,"sha":..,"source":"run|adopted"}
created_add() { python3 -c 'import json,sys;print(json.dumps({"kind":sys.argv[1],"id":sys.argv[2],"sha":sys.argv[3] or None,"source":sys.argv[4]}))' "$@" >> "$CREATED"; }
created_list() { python3 -c 'import json,sys;[print(d["id"], d["sha"] or "-", d["source"]) for d in map(json.loads, open(sys.argv[1])) if d["kind"]==sys.argv[2]]' "$CREATED" "$1"; }
is_created() { python3 -c 'import json,sys;sys.exit(0 if any(d["kind"]==sys.argv[2] and str(d["id"])==sys.argv[3] for d in map(json.loads, open(sys.argv[1]))) else 1)' "$CREATED" "$1" "$2"; }

# ---------------------------------------------------------------- GitHub reads (agentbox gh, read-only) with status
# ghr <path> : sets GH_CODE (HTTP status, 000 = transport failure) and GH_BODY
ghr() {
  local out; out=$(gh api --include "$1" 2>/dev/null)
  GH_CODE=$(printf '%s\n' "$out" | head -1 | awk '{print $2}'); GH_CODE=${GH_CODE:-000}
  GH_BODY=$(printf '%s\n' "$out" | sed '1,/^\r\{0,1\}$/d')
}
jq_body() { printf '%s' "$GH_BODY" | python3 -c "import json,sys;d=json.load(sys.stdin);$1"; }
# ref_sha <ref-name without refs/heads/> -> sha | ABSENT | ERR:<code>
ref_sha() { ghr "repos/$REPO/git/ref/heads/$1"
  case "$GH_CODE" in 200) jq_body 'print(d["object"]["sha"])';; 404) echo ABSENT;; *) echo "ERR:$GH_CODE";; esac; }
# prefix_refs -> "name sha" lines of every branch under cloud/<host>/ ; returns 1 on API failure
prefix_refs() { ghr "repos/$REPO/git/matching-refs/heads/$PFX"
  [ "$GH_CODE" = 200 ] || return 1
  jq_body '[print(r["ref"][len("refs/heads/"):], r["object"]["sha"]) for r in d]'; }
# item_state <number> -> "open|closed <title-ok:0|1> <bot:0|1>" | ERR:<code>
item_state() { ghr "repos/$REPO/issues/$1"
  [ "$GH_CODE" = 200 ] || { echo "ERR:$GH_CODE"; return; }
  jq_body 'print(d["state"], int(d["title"].lower().startswith("[runpane-cloud")), int(d["user"]["login"].endswith("[bot]") or "<!-- runpane-cloud:" in (d.get("body") or "")))'; }

# ---------------------------------------------------------------- credential kind (never printed)
if grep -q "BEGIN .*PRIVATE KEY" "$CRED" 2>/dev/null; then
  KIND=app; [ -n "$APP_ID" ] || { [ -f "$(dirname "$CRED")/github-app-id" ] && APP_ID=$(tr -d ' \r\n' < "$(dirname "$CRED")/github-app-id"); }
  [ -n "$APP_ID" ] || { echo "App key given: pass --app-id or --app-id-file" >&2; exit 2; }
else
  KIND=pat
  case "$(head -c 11 "$CRED")" in github_pat_) ;; *) echo "refusing: not a fine-grained PAT (github_pat_…) nor an App .pem" >&2; exit 2;; esac
fi
[ "$(stat -c %a "$CRED")" = 600 ] || { echo "refusing: $CRED must be mode 0600" >&2; exit 2; }
log "P4 repo=$REPO host=$HOST branch=$FULL credential=$KIND mode=$MODE dry=$DRY keep-branch=$KEEP_BRANCH keep-open=$KEEP_OPEN evidence=$EV"

# user-credential writes (cleanup only): App installation token (1 repo) or the PAT, in a 0600 header file
user_auth_header() {
  local hf="$SEC/gh-auth.hdr"
  if [ "$KIND" = app ]; then
    local jwt inst tok
    jwt=$(app_jwt "$CRED" "$APP_ID")
    inst=${INST:-$(curl -sS -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' "$P4_API/repos/$REPO/installation" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)}
    [ -n "$inst" ] || return 1
    tok=$(curl -sS -X POST -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' \
      -d "{\"repositories\":[\"$NAME\"],\"permissions\":{\"contents\":\"write\",\"pull_requests\":\"write\",\"issues\":\"write\"}}" \
      "$P4_API/app/installations/$inst/access_tokens" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
    [ -n "$tok" ] || return 1
    (umask 077; printf 'Authorization: token %s\n' "$tok" > "$hf")
  else
    (umask 077; printf 'Authorization: token %s\n' "$(tr -d '\r\n' < "$CRED")" > "$hf")
  fi
  echo "$hf"
}
ghw() {  # ghw <METHOD> <path> [json] : a write with the USER's credential; prints the HTTP status (000 = no credential)
  local hf c; hf=$(user_auth_header) || { echo 000; return 1; }
  c=$(curl -sS -o "$EV/.ghw.json" -w '%{http_code}' -X "$1" -H @"$hf" -H 'Accept: application/vnd.github+json' ${3:+-d "$3"} "$P4_API/repos/$REPO$2")
  shred -u "$hf"
  echo "$(date -u +%FT%TZ) GITHUB $1 $REPO$2 -> $c (p3-e2e P4, user credential)" >> "$HOME/rc-loop/mutations.log"
  echo "$c"
}
# delete_ref <name> <expected-sha> : deletes only if the branch still points at the recorded sha
delete_ref() {
  local cur c; cur=$(ref_sha "$1")
  case "$cur" in
    ABSENT) log "branch $1 already absent"; return 0;;
    ERR:*) rec "delete.$1" FAIL "could not read the branch before deleting ($cur): not deleted"; return 1;;
  esac
  [ "$cur" = "$2" ] || { rec "delete.$1" FAIL "branch moved ($cur, recorded $2): NOT deleted"; return 1; }
  c=$(ghw DELETE "/git/refs/heads/$1")
  [ "$c" = 204 ] && { log "deleted $1 ($2)"; return 0; }
  rec "delete.$1" FAIL "DELETE /git/refs/heads/$1 -> HTTP $c: $(head -c 200 "$EV/.ghw.json" 2>/dev/null)"; return 1
}

# ---------------------------------------------------------------- 0. preflight (read-only)
M0=$(ref_sha master)
[[ "$M0" == "$EXPECT"* ]] && rec preflight.master PASS "master $M0" || { rec preflight.master FAIL "master is $M0, expected $EXPECT"; exit 1; }
PRE=$(prefix_refs) || { rec preflight.prefix-refs FAIL "listing refs under $PFX failed (HTTP $GH_CODE)"; exit 1; }
printf '%s\n' "$PRE" > "$EV/preexisting-refs.txt"
rec preflight.prefix-refs PASS "pre-existing refs under $PFX (recorded, never touched unless adopted): $(tr '\n' ';' <<<"${PRE:-none}")"
for spec in "${ADOPT_BRANCHES[@]}"; do
  n="${spec%@*}"; s="${spec#*@}"; [[ "$n" == "$PFX"* ]] || n="$PFX$n"
  [[ "$spec" == *@* && "$s" =~ ^[0-9a-f]{7,40}$ ]] || { rec "preflight.adopt-branch" FAIL "$spec: use NAME@SHA"; exit 1; }
  cur=$(ref_sha "$n")
  if [ "$cur" = ABSENT ]; then rec "preflight.adopt-branch" PASS "$n already gone (nothing to adopt)"
  elif [[ "$cur" == "$s"* ]]; then created_add branch "$n" "$cur" adopted; echo "$n" >> "$EV/adopted-branches.txt"; rec "preflight.adopt-branch" PASS "$n @ ${cur:0:12} adopted (sha matches)"
  else rec "preflight.adopt-branch" FAIL "$n is $cur, not $s: NOT adopted"; exit 1; fi
done
for kind in issue pr; do
  if [ "$kind" = issue ]; then list=("${ADOPT_ISSUES[@]}"); else list=("${ADOPT_PRS[@]}"); fi
  for n in "${list[@]}"; do
    st=$(item_state "$n")
    read -r state tok bot <<<"$st"
    if [[ "$st" == ERR:* ]]; then rec "preflight.adopt-$kind-#$n" FAIL "read failed ($st)"; exit 1; fi
    [ "$tok" = 1 ] && [ "$bot" = 1 ] || { rec "preflight.adopt-$kind-#$n" FAIL "#$n doesn't look like a runpane-cloud test item ("[runpane-cloud" title and a [bot] author or the broker marker): NOT adopted"; exit 1; }
    created_add "$kind" "$n" "" adopted; rec "preflight.adopt-$kind-#$n" PASS "#$n ($state) adopted for cleanup"
  done
done
cur=$(ref_sha "$FULL")
case "$cur" in
  ABSENT) rec preflight.branch-free PASS "$FULL does not exist";;
  ERR:*) rec preflight.branch-free FAIL "could not read $FULL ($cur)"; exit 1;;
  *) if is_created branch "$FULL" && [ "$KEEP_BRANCH" != 1 ]; then rec preflight.branch-free PASS "$FULL exists (${cur:0:12}) but is adopted: deleted before the run"
     else rec preflight.branch-free FAIL "$FULL already exists (${cur:0:12}) and is not adopted (or --keep-branch): pick another --branch"; exit 1; fi;;
esac
REC_FILE="${RUNPANE_CLOUD_DIR:-$HOME/.config/runpane-cloud}/hosts/$HOST.json"
S_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["profile"]["cloud"]["sandboxId"])' "$REC_FILE") || { echo "no host record $REC_FILE" >&2; exit 1; }
CLOUDLAB_BOAT_ORG=$(python3 -c 'import json,sys;print(((json.load(open(sys.argv[1])).get("meta") or {}).get("boatOrg") or {}).get("id") or "")' "$REC_FILE")
[ -n "$CLOUDLAB_BOAT_ORG" ] && export CLOUDLAB_BOAT_ORG || unset CLOUDLAB_BOAT_ORG
session_state() { cl boat get "$S_ID" --field state 2>/dev/null; }
st=$(session_state)
if [ "$DRY" = 1 ]; then
  [[ "$st" =~ ^(idle|ready|running)$ ]] && rec preflight.session PASS "$HOST $S_ID state=$st" || rec preflight.session INFO "$HOST $S_ID state=$st (a real run needs it awake, or --wake-if-asleep)"
  log "DRY RUN: cleanup would touch ONLY these (closing issues/PRs; deleting branches only if still at the sha, never with --keep-branch):"
  [ -s "$CREATED" ] && sed 's/^/  adopted: /' "$CREATED" || log "  (nothing adopted)"
  log "  + what the run itself creates: $FULL, one issue, one draft PR"
  keep=$(while read -r name sha; do [ -n "$name" ] && ! is_created branch "$name" && echo "$name@${sha:0:12}"; done <<<"$PRE")
  log "  NEVER touched (pre-existing, not adopted): $(tr '\n' ' ' <<<"${keep:-none}")"
  exit $((FAILS > 0))
fi
if ! [[ "$st" =~ ^(idle|ready|running)$ ]]; then
  if [ "$WAKE" = 1 ]; then rpc cloud wake "$HOST" --json > "$EV/wake.json" 2>&1; st=$(session_state); fi
  [[ "$st" =~ ^(idle|ready|running)$ ]] || { rec preflight.session FAIL "$HOST $S_ID state=$st (asleep: wake it, or pass --wake-if-asleep)"; exit 1; }
fi
rec preflight.session PASS "$HOST $S_ID state=$st"

# ---------------------------------------------------------------- keepalive + awake guard
( while :; do rpc --host "$HOST" panels list --json >/dev/null 2>&1; sleep 60; done ) &
KEEPALIVE=$!
SESSION_OK=1
require_awake() {  # require_awake <step> : FAIL loudly (once per step) if the Session is not running
  local s; s=$(session_state)
  [[ "$s" =~ ^(idle|ready|running)$ ]] && return 0
  rec "session.awake.$1" FAIL "$HOST is $s before '$1': the step is skipped (the keepalive should have prevented this)"
  SESSION_OK=0; return 1
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  kill "$KEEPALIVE" 2>/dev/null
  log "== cleanup (only items in $CREATED)"
  cp "$CREATED" "$EV/created-final.jsonl"
  local n src s c
  if [ "$KEEP_OPEN" != 1 ]; then
    while read -r kind n _ src; do
      [ "$kind" = issue ] || [ "$kind" = pr ] || continue
      s=$(item_state "$n"); [[ "$s" == closed* ]] && continue
      if [ "$SESSION_OK" = 1 ] && require_awake "close-#$n"; then
        sbx "$S_ID" 120 <<<"cd ${SPATH:-/home/user}; gh $kind close $n; echo \"gh $kind close $n exit=\$?\"" >> "$EV/cleanup-session.txt" 2>&1
      fi
      s=$(item_state "$n")
      if [[ "$s" != closed* ]]; then
        log "#$n still ${s%% *} after the broker close: closing with the user credential"
        c=$(ghw PATCH "/issues/$n" '{"state":"closed"}'); [ "$c" = 200 ] || rec "close.#$n" FAIL "PATCH -> HTTP $c"
      fi
    done < <(python3 -c 'import json,sys;[print(d["kind"], d["id"], d["sha"] or "-", d["source"]) for d in map(json.loads, open(sys.argv[1]))]' "$CREATED")
  fi
  if [ "$KEEP_BRANCH" != 1 ]; then
    while read -r n sha src; do delete_ref "$n" "$sha"; done < <(created_list branch)
  else log "--keep-branch: no ref is deleted"; fi
  sbx "$S_ID" 60 <<SH >/dev/null 2>&1
cd "${SPATH:-/nonexistent}" 2>/dev/null && { git worktree remove --force /home/user/rcl/p4-proof; git worktree prune; git branch -D $BR wf-p4; } 2>/dev/null; rm -f /home/user/rcl/p4-*.b64 /home/user/rcl/p4-*.bundle
SH
  # ---- final checks: fresh reads only; a failed read is a FAIL
  local m1 now; m1=$(ref_sha master)
  [ "$m1" = "$M0" ] && rec final.master PASS "master still $m1" || rec final.master FAIL "master is $m1 (was $M0)"
  if now=$(prefix_refs); then
    printf '%s\n' "$now" > "$EV/final-refs.txt"
    while read -r name sha; do [ -n "$name" ] || continue
      grep -qx "$name" "$EV/adopted-branches.txt" 2>/dev/null && continue   # adopted: judged by final.deleted / pre.adopted-branch-deleted
      grep -qx "$name $sha" <<<"$now" && rec "final.preexisting.$name" PASS "untouched at ${sha:0:12}" || rec "final.preexisting.$name" FAIL "changed or gone (was $sha)"
    done <<<"$PRE"
    while read -r name sha; do [ -n "$name" ] || continue
      grep -q "^$name " <<<"$PRE" && continue
      if is_created branch "$name"; then
        [ "$KEEP_BRANCH" = 1 ] && rec "final.ours.$name" PASS "kept (--keep-branch) at ${sha:0:12}" || rec "final.ours.$name" FAIL "still present at ${sha:0:12} (deletion failed)"
      else rec "final.unexpected.$name" FAIL "NEW ref not created by this run (${sha:0:12}): reported, NOT deleted"; fi
    done <<<"$now"
    while read -r n sha src; do
      [ "$KEEP_BRANCH" = 1 ] && continue
      s=$(ref_sha "$n"); [ "$s" = ABSENT ] && rec "final.deleted.$n" PASS "404 on GitHub (was ${sha:0:12}, $src)" || rec "final.deleted.$n" FAIL "ref read: $s"
      grep -q "^$n " <<<"$now" && [ "$s" = ABSENT ] && rec "final.consistent.$n" FAIL "listing and ref read disagree"
    done < <(created_list branch)
  else rec final.prefix-refs FAIL "listing refs under $PFX failed (HTTP $GH_CODE)"; fi
  while read -r kind n _ src; do
    [ "$kind" = issue ] || [ "$kind" = pr ] || continue
    s=$(item_state "$n")
    if [ "$KEEP_OPEN" = 1 ]; then rec "final.$kind-#$n" INFO "${s%% *} (--keep-open)"
    else [[ "$s" == closed* ]] && rec "final.$kind-#$n" PASS "closed ($src)" || rec "final.$kind-#$n" FAIL "$s"; fi
  done < <(python3 -c 'import json,sys;[print(d["kind"], d["id"], d["sha"] or "-", d["source"]) for d in map(json.loads, open(sys.argv[1]))]' "$CREATED")
  shred -u "$SEC"/* 2>/dev/null; rm -rf "$SEC"
  grep -rlE 'ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|BEGIN (RSA )?PRIVATE' "$EV" 2>/dev/null | while read -r f; do rec evidence.no-secret FAIL "secret-looking text in $f"; done
  log "P4: $FAILS failure(s); results $RESULTS"
}
trap 'cleanup; exit $((FAILS > 0))' EXIT
trap 'exit 143' TERM INT

# an adopted run branch is removed before the run pushes the same name (preflight checked its sha)
if is_created branch "$FULL"; then
  delete_ref "$FULL" "$(created_list branch | awk -v f="$FULL" '$1==f{print $2}')" || exit 1
  s=$(ref_sha "$FULL"); [ "$s" = ABSENT ] && rec pre.adopted-branch-deleted PASS "$FULL (adopted) deleted before the run: 404 on GitHub" \
    || { rec pre.adopted-branch-deleted FAIL "$FULL still reads $s"; exit 1; }
  # retire the adopted entry: the name now belongs to this run's push (recorded again with its own sha)
  python3 -c 'import json,sys;p=sys.argv[1];r=[l for l in open(p) if not (json.loads(l)["kind"]=="branch" and json.loads(l)["id"]==sys.argv[2])];open(p,"w").writelines(r)' "$CREATED" "$FULL"
fi

# ---------------------------------------------------------------- 1. broker credential + allowlist
if [ "$REDEPLOY" = 1 ]; then rpc cloud coordinator deploy --yes --json > "$EV/coordinator-deploy.json" 2>&1 && rec coordinator.redeploy PASS "in place" || rec coordinator.redeploy FAIL "see coordinator-deploy.json"; fi
if [ "$SKIP_SET" != 1 ]; then
  if [ "$KIND" = app ]; then out=$(rpc cloud coordinator github set --app-id "$APP_ID" --private-key-file "$CRED" ${INST:+--installation-id "$INST"} --json 2>&1)
  else out=$(rpc cloud coordinator github set --pat-file "$CRED" --json 2>&1); fi
  rc=$?; printf '%s\n' "$out" > "$EV/github-set.json"; rec broker.set "$([ $rc = 0 ] && echo PASS || echo FAIL)" "coordinator github set ($KIND) rc=$rc"
  [ $rc = 0 ] || exit 1
fi
rpc cloud coordinator github status --json > "$EV/github-status.json" 2>&1
out=$(rpc cloud github connect "$HOST" --repo "$REPO" --broker --json 2>&1); rc=$?; printf '%s\n' "$out" > "$EV/connect.json"
rec broker.connect "$([ $rc = 0 ] && echo PASS || echo FAIL)" "github connect $HOST --repo $REPO --broker rc=$rc"; [ $rc = 0 ] || exit 1

# ---------------------------------------------------------------- 3. in the Session
require_awake clone || exit 1
[ -n "$SPATH" ] || SPATH=$(sbx "$S_ID" 60 <<'SH' | tail -1
for d in /home/user/*/ /home/user/*/*/; do [ -d "$d/.git" ] && git -C "$d" remote get-url origin 2>/dev/null | grep -qi montlakev2 && { echo "${d%/}"; exit; }; done
SH
)
[ -n "$SPATH" ] || { rec session.clone FAIL "no montlakev2 clone found in the Session (pass --path)"; exit 1; }
rec session.clone PASS "$SPATH"
bcall_install "$S_ID" > "$EV/bcall-install.txt" 2>&1
TITLE="$TITLE_PREFIX P4 broker proof $(date -u +%FT%H%MZ)"
BODY="Opened from the runpane cloud Session $HOST through its coordinator's GitHub broker (no laptop in the path). Test only: it will be closed and its branch deleted within minutes. master must stay at $EXPECT."
PR=""; ISSUE=""
if [ "$MODE" = agent ]; then
  log "== agent mode: giving the task to a Claude panel in $HOST"
  TASK="$EV/agent-task.txt"
  cat > "$TASK" <<EOF
In $SPATH (a clone of $REPO) do exactly this, then stop. You have no GitHub credentials; use only the commands named here.
1. \`git fetch origin master\` then \`git worktree add /home/user/rcl/p4-proof -b $BR origin/master\`; in that worktree add
   .runpane-cloud-test/p3-proof.md with the line "runpane cloud broker proof", commit "test: runpane cloud broker proof"
   (if git has no identity, use \`git -c user.name=runpane-cloud-agent -c user.email=agent@$HOST.invalid commit ...\`).
2. \`runpane cloud agent github push --path /home/user/rcl/p4-proof --branch $BR\`
3. \`gh issue create --title "$TITLE" --body "$BODY"\`
4. \`gh pr create --draft --head $BR --title "$TITLE" --body "$BODY"\`
Never push to master and never merge. If a step fails, do not retry it differently; report it.
Reply with exactly one line: RESULT issue=<n or none> pr=<n or none>
EOF
  pane=$(rpc --host "$HOST" panes create --repo "$(basename "$SPATH")" --name p4-proof --agent claude --no-focus --wait-ready --ready-timeout-ms 120000 --yes --json 2>&1)
  panel=$(python3 -c 'import json,sys;print(((json.loads(sys.argv[1]).get("items") or [{}])[0]).get("panelId") or "")' "$pane" 2>/dev/null)
  [ -n "$panel" ] || { rec agent.pane FAIL "panes create: $(head -c 300 <<<"$pane")"; exit 1; }
  rpc --host "$HOST" panels submit --panel "$panel" --input-file "$TASK" --yes --json > "$EV/agent-submit.json" 2>&1
  end=$(( $(date +%s) + AGENT_TIMEOUT )); result=""
  while [ "$(date +%s)" -lt "$end" ]; do
    require_awake agent-wait || break
    rpc --host "$HOST" panels last-message --panel "$panel" --json > "$EV/agent-last-message.json" 2>&1
    result=$(python3 -c 'import json,re,sys;t=json.load(open(sys.argv[1])).get("text") or "";m=re.search(r"RESULT issue=(\S+) pr=(\S+)",t);print(m.group(1),m.group(2)) if m else None' "$EV/agent-last-message.json" 2>/dev/null)
    [ -n "$result" ] && [ "$result" != None ] && break; result=""; sleep 15
  done
  if [ -n "$result" ]; then
    read -r ISSUE PR <<<"$result"; ISSUE=$(tr -dc 0-9 <<<"$ISSUE"); PR=$(tr -dc 0-9 <<<"$PR")
    rec agent.result PASS "agent answered: RESULT $result"
  else rec agent.result FAIL "no RESULT line within ${AGENT_TIMEOUT}s"; fi
else
  log "== script mode: the same CLI the agent uses, driven over boat exec"
  q=$(printf '%q ' "$TITLE"); qb=$(printf '%q ' "$BODY")
  sbx "$S_ID" 600 <<SH > "$EV/session-steps.txt" 2>&1
set -x
cd $SPATH && git fetch -q origin master && git worktree add -q /home/user/rcl/p4-proof -b $BR origin/master
cd /home/user/rcl/p4-proof && mkdir -p .runpane-cloud-test && echo "runpane cloud broker proof" > .runpane-cloud-test/p3-proof.md
git add -A && git -c user.name=runpane-cloud-agent -c user.email=agent@$HOST.invalid commit -qm "test: runpane cloud broker proof" && git log --oneline -1
runpane cloud agent github push --path /home/user/rcl/p4-proof --branch $BR --json; echo "push exit=\$?"
gh issue create --title $q --body $qb; echo "issue exit=\$?"
gh pr create --draft --head $BR --title $q --body $qb; echo "pr exit=\$?"
SH
  PR=$(grep -oE "github.com/$REPO/pull/[0-9]+" "$EV/session-steps.txt" | head -1 | grep -oE '[0-9]+$')
  ISSUE=$(grep -oE "github.com/$REPO/issues/[0-9]+" "$EV/session-steps.txt" | head -1 | grep -oE '[0-9]+$')
fi
# record what exists now and is ours, verified on GitHub (so cleanup can act on it even if a later step fails)
s=$(ref_sha "$FULL")
case "$s" in ABSENT) rec github.pushed FAIL "$FULL is not on GitHub";; ERR:*) rec github.pushed FAIL "read failed ($s)";;
  *) created_add branch "$FULL" "$s" run; rec github.pushed PASS "$FULL @ ${s:0:12}";; esac
for pair in "issue:$ISSUE" "pr:$PR"; do
  kind=${pair%%:*}; n=${pair#*:}
  [ -n "$n" ] || { rec "github.$kind" FAIL "no $kind number (see session-steps.txt / agent-last-message.json)"; continue; }
  st=$(item_state "$n"); read -r state tok bot <<<"$st"
  if [ "$tok" = 1 ] && [ "$bot" = 1 ]; then created_add "$kind" "$n" "" run; rec "github.$kind" PASS "#$n $state"
  else rec "github.$kind" FAIL "#$n doesn't look like ours ($st): not recorded, not touched"; fi
done
log "PR=#${PR:-none} issue=#${ISSUE:-none}"

# ---------------------------------------------------------------- refusals (always scripted, from inside the Session)
if require_awake refusals; then
sbx "$S_ID" 120 <<SH > "$EV/.bundles.txt" 2>&1
cd $SPATH && git fetch -q origin master
git branch -f wf-p4 origin/master && git worktree add -q /home/user/rcl/p4-wf wf-p4 && cd /home/user/rcl/p4-wf
f=\$(ls .github/workflows/*.y*ml | head -1); echo "# runpane-cloud TEST" >> "\$f"; git -c user.name=p4 -c user.email=p4@x.invalid commit -qam "test: touch a workflow"
git bundle create /home/user/rcl/p4-wf.bundle wf-p4 --not origin/master >/dev/null 2>&1 && base64 -w0 /home/user/rcl/p4-wf.bundle > /home/user/rcl/p4-wf.b64
cd $SPATH && git worktree remove --force /home/user/rcl/p4-wf
git bundle create /home/user/rcl/p4-ok.bundle $BR --not origin/master >/dev/null 2>&1 && base64 -w0 /home/user/rcl/p4-ok.bundle > /home/user/rcl/p4-ok.b64
ls -l /home/user/rcl/p4-*.b64
SH
probe() {  # probe <check> <http-regex> <cmd...> (runs in the Session)
  local c="$1" want="$2"; shift 2
  require_awake "refuse.$c" || return
  local q r; q=$(printf '%q ' "$@"); r=$(sbx "$S_ID" 120 <<<"/home/user/rcl/$q" | tail -1)
  printf '%s -> %s\n' "$*" "$r" >> "$EV/refusals.txt"
  [[ "$(awk '{print $1}' <<<"$r")" =~ ^($want)$ ]] && rec "refuse.$c" PASS "$(head -c 160 <<<"$r")" || rec "refuse.$c" FAIL "$(head -c 200 <<<"$r")"
}
probe master-short     '403'     pushprobe "$REPO" "master" /home/user/rcl/p4-ok.b64
probe master-dotdot    '400|403' pushprobe "$REPO" "../../master" /home/user/rcl/p4-ok.b64
probe master-slash     '400|403' pushprobe "$REPO" "/master" /home/user/rcl/p4-ok.b64
probe master-force     '400|403' pushprobe "$REPO" "../../master" /home/user/rcl/p4-ok.b64 '{"force":true}'
probe workflow-change  '403'     pushprobe "$REPO" "p4-wf" /home/user/rcl/p4-wf.b64
[ -n "$PR" ] && probe merge-put        '403|404|405' bcall PUT "/cloud/github/pulls/$PR/merge" '{}'
[ -n "$PR" ] && probe ready-for-review '400|403'     bcall PATCH "/cloud/github/pulls/$PR" "{\"repo\":\"$REPO\",\"draft\":false}"
if require_awake shim; then
  sh=$(sbx "$S_ID" 60 <<SH
cd $SPATH; gh pr merge ${PR:-1} --merge >/dev/null 2>&1; echo "merge=\$?"; gh pr ready ${PR:-1} >/dev/null 2>&1; echo "ready=\$?"
git push origin HEAD:master >/dev/null 2>&1; echo "gitpush=\$?"
SH
)
  printf '%s\n' "$sh" >> "$EV/refusals.txt"
  grep -q '^merge=2$' <<<"$sh" && grep -q '^ready=2$' <<<"$sh" && grep -qE '^gitpush=[1-9]' <<<"$sh" \
    && rec refuse.shim-and-direct-push PASS "gh pr merge/ready exit 2; direct git push to master fails (read-only Session)" || rec refuse.shim-and-direct-push FAIL "$(tr '\n' ' ' <<<"$sh")"
fi
fi

# ---------------------------------------------------------------- 4. verify on GitHub (read-only)
if [ -n "$PR" ]; then
  ghr "repos/$REPO/pulls/$PR"
  if [ "$GH_CODE" = 200 ]; then
    printf '%s' "$GH_BODY" > "$EV/github-pr.json"
    v=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["draft"],d["head"]["ref"],d["base"]["ref"],d["user"]["login"],d["title"].startswith(sys.argv[2]),d["merged"])' "$EV/github-pr.json" "$TITLE_PREFIX")
    read -r draft head base user tprefix merged <<<"$v"
    [ "$draft" = True ] && [ "$head" = "$FULL" ] && [ "$base" = master ] && [ "$tprefix" = True ] && [ "$merged" = False ] \
      && rec github.draft-pr PASS "#$PR draft from $head into $base by $user" || rec github.draft-pr FAIL "$v"
    [ "$KIND" = app ] && { [[ "$user" == *"[bot]" ]] && rec github.pr-author PASS "$user (the App, not Red: Red can approve it)" || rec github.pr-author FAIL "$user"; }
  else rec github.draft-pr FAIL "GET pulls/$PR -> HTTP $GH_CODE"; fi
fi
m=$(ref_sha master); [ "$m" = "$M0" ] && rec github.master-unchanged PASS "$m" || rec github.master-unchanged FAIL "$m"
if now=$(prefix_refs); then
  new=$(while read -r name sha; do [ -n "$name" ] && ! grep -qx "$name $sha" <<<"$PRE" && echo "$name"; done <<<"$now")
  [ "$new" = "$FULL" ] && rec github.only-proof-ref PASS "the only new ref under $PFX is $FULL (pre-existing left alone: $(wc -l <<<"$PRE" | tr -d ' '))" \
    || rec github.only-proof-ref FAIL "new refs under $PFX: $(tr '\n' ' ' <<<"${new:-none}")"
else rec github.only-proof-ref FAIL "listing refs failed (HTTP $GH_CODE)"; fi
rpc cloud coordinator github audit --json > "$EV/coordinator-github-audit.json" 2>&1
# cleanup + final verification run from the EXIT trap
