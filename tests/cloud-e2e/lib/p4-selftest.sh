#!/usr/bin/env bash
# Self-test of p4-montlake.sh's SAFETY logic (adopt / record / cleanup / final checks) against the fake GitHub, locally:
# no Session (P4_STUB_SESSION=1), a `gh` shim that reads the fake, and a fine-grained-PAT-shaped credential.
# The fake repo mirrors montlakev2's situation after the failed P4 run: a pre-existing ref that isn't ours
# (cloud/h1/p2-issue-408), a leftover proof branch (cloud/h1/p3-proof) and a leftover issue from the broker (#1).
# Usage: tests/cloud-e2e/lib/p4-selftest.sh [workdir]
set -uo pipefail
LIB="$(cd "$(dirname "$0")" && pwd)"; P4="$LIB/../p4-montlake.sh"
W="${1:-$(mktemp -d)}"; mkdir -p "$W"; ST="$W/state"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x.invalid

PAT="github_pat_SELFTEST$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
(umask 077; printf '%s\n' "$PAT" > "$W/pat")
python3 "$LIB/fakegithub.py" init --state "$ST" --repo acme/app --pat-file "$W/pat" >/dev/null
python3 "$LIB/fakegithub.py" serve --state "$ST" --port 0 --port-file "$W/port" >"$W/serve.log" 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 50); do [ -s "$W/port" ] && break; sleep 0.1; done
B="http://127.0.0.1:$(cat "$W/port")"; BARE="$ST/git/acme/app.git"
g() { git --git-dir="$BARE" "$@"; }
M=$(g rev-parse master); T=$(g rev-parse "master^{tree}")
mk() { g commit-tree "$T" -p "$M" -m "$1"; }
g update-ref refs/heads/cloud/h1/p2-issue-408 "$(mk "red's phase 2 deliverable")"; P2=$(g rev-parse cloud/h1/p2-issue-408)
g update-ref refs/heads/cloud/h1/p3-proof "$(mk 'failed run leftover')"; OLD=$(g rev-parse cloud/h1/p3-proof)
ADM=(-H "X-Fake-Admin: $(cat "$ST/admin-token")")
curl -s "${ADM[@]}" -X POST -d '{"repo":"acme/app","title":"[runpane-cloud test] P4 broker proof","body":"x\n<!-- runpane-cloud:h1sess -->"}' "$B/_fake/seed/issue" >/dev/null   # #1 (bot, marker)
curl -s -H "Authorization: token $PAT" -X POST -d '{"title":"a human issue","body":"please fix"}' "$B/repos/acme/app/issues" >/dev/null                   # #2 (human)

# gh shim: `gh api --include <path>` -> the fake, with the PAT (reads only)
mkdir -p "$W/bin"
cat > "$W/bin/gh" <<SH
#!/bin/sh
[ "\$1" = api ] && [ "\$2" = --include ] || { echo "gh shim: only 'gh api --include' is modelled" >&2; exit 2; }
exec curl -si -H "Authorization: token $PAT" "$B/\$3"
SH
chmod 755 "$W/bin/gh"
mkdir -p "$W/cloud/hosts"; echo '{"profile":{"cloud":{"sandboxId":"bx_stub"}},"meta":{}}' > "$W/cloud/hosts/h1.json"
run() {  # run <case> [p4 args...]
  local c="$1"; shift
  PATH="$W/bin:$PATH" P4_API="$B" P4_STUB_SESSION=1 RUNPANE_CLOUD_DIR="$W/cloud" P4_EVIDENCE_DIR="$W/ev-$c" \
    P4_STUB_SBX="${STUB_SBX:-}" "$P4" "$W/pat" h1 --repo acme/app --expect-master "$M" --path /stub/app "$@" > "$W/$c.log" 2>&1
  echo $?
}
has() { grep -qE "$2" "$W/ev-$1/results.txt"; }
refsha() { g rev-parse --verify -q "refs/heads/$1" || echo ABSENT; }

# ---- case 1: adopt the leftovers; the "Session" pushes the proof branch and something else also appears (an intruder)
# the stub "Session" pushes once (a marker file), like the real one; a re-push during cleanup would be a real FAIL
STUB_SBX="[ -e '$W/c1.pushed' ] || { touch '$W/c1.pushed'; git --git-dir='$BARE' update-ref refs/heads/cloud/h1/p3-proof \$(git --git-dir='$BARE' commit-tree $T -p $M -m run); git --git-dir='$BARE' update-ref refs/heads/cloud/h1/intruder $M; }"
rc=$(STUB_SBX="$STUB_SBX" run c1 --adopt-branch "p3-proof@$OLD" --adopt-issue 1)
has c1 '^PASS +pre.adopted-branch-deleted' && ok "adopted leftover branch deleted before the run (sha-checked)" || bad "c1 pre-delete"
has c1 '^PASS +github.pushed' && ok "the run's own push is recorded with its sha" || bad "c1 pushed"
[ "$(refsha cloud/h1/p2-issue-408)" = "$P2" ] && has c1 '^PASS +final.preexisting.cloud/h1/p2-issue-408' && ok "pre-existing ref untouched and reported so" || bad "c1 p2-issue-408"
[ "$(refsha cloud/h1/intruder)" != ABSENT ] && has c1 '^FAIL +final.unexpected.cloud/h1/intruder' && ok "a NEW ref that isn't ours: FAIL + reported, NOT deleted" || bad "c1 intruder"
[ "$(refsha cloud/h1/p3-proof)" = ABSENT ] && has c1 '^PASS +final.deleted.cloud/h1/p3-proof' && ok "the run's branch deleted and confirmed 404" || bad "c1 proof branch"
has c1 '^PASS +final.issue-#1 +closed' && ok "adopted issue #1 closed (fallback with the user credential) and re-read" || bad "c1 issue #1"
has c1 '^FAIL +github.only-proof-ref' && ok "only-proof-ref sees the intruder as a new ref (pre-existing ones excluded)" || bad "c1 only-proof-ref"
[ "$rc" = 1 ] && ok "exit 1 (there were FAILs)" || bad "c1 exit $rc"
grep -q "DELETE" "$W/ev-c1/p4.log" >/dev/null; n_del=$(python3 -c 'import json,sys;print(sum(1 for l in open(sys.argv[1]) if json.loads(l).get("deletedRef")))' "$ST/requests.jsonl")
[ "$n_del" = 2 ] && ok "exactly 2 ref deletions reached GitHub (the adopted leftover and the run's branch)" || bad "c1 deletions=$n_del"

# ---- case 2: --keep-branch never deletes (a new branch name, since the proof branch name is taken by nothing now)
g update-ref -d refs/heads/cloud/h1/intruder
g update-ref refs/heads/cloud/h1/p3-proof "$OLD"
rc=$(run c2 --keep-branch --adopt-branch "p3-proof@$OLD")
has c2 '^FAIL +preflight.branch-free' && [ "$(refsha cloud/h1/p3-proof)" = "$OLD" ] && ok "--keep-branch + existing proof branch: preflight refuses, nothing deleted" || bad "c2 keep-branch"
STUB_SBX="[ -e '$W/c3.pushed' ] || { touch '$W/c3.pushed'; git --git-dir='$BARE' update-ref refs/heads/cloud/h1/p3-proof-b $M; }"
before=$(python3 -c 'import json,sys;print(sum(1 for l in open(sys.argv[1]) if json.loads(l).get("deletedRef")))' "$ST/requests.jsonl")
rc=$(STUB_SBX="$STUB_SBX" run c3 --keep-branch --branch p3-proof-b)
after=$(python3 -c 'import json,sys;print(sum(1 for l in open(sys.argv[1]) if json.loads(l).get("deletedRef")))' "$ST/requests.jsonl")
[ "$before" = "$after" ] && [ "$(refsha cloud/h1/p3-proof-b)" != ABSENT ] && has c3 '^PASS +final.ours.cloud/h1/p3-proof-b +kept' && ok "--keep-branch: 0 deletions, own branch reported kept" || bad "c3 keep ($before/$after)"
[ "$(refsha cloud/h1/p3-proof)" = "$OLD" ] && has c3 '^PASS +final.preexisting.cloud/h1/p3-proof' && ok "a leftover that isn't adopted is left alone" || bad "c3 leftover"

# ---- case 4: adoption refuses a human issue and a wrong sha
rc=$(run c4 --dry-run --adopt-issue 2); has c4 '^FAIL +preflight.adopt-issue-#2' && [ "$rc" = 1 ] && ok "a human issue is not adopted (exit 1)" || bad "c4"
rc=$(run c5 --dry-run --adopt-branch p3-proof@deadbeef); has c5 '^FAIL +preflight.adopt-branch' && [ "$rc" = 1 ] && ok "a wrong sha is not adopted (exit 1)" || bad "c5"
# ---- case 6: a failing GitHub read is a FAIL, never a silent pass
kill $SRV; wait $SRV 2>/dev/null
rc=$(run c6 --dry-run); has c6 '^FAIL +preflight.master' && [ "$rc" = 1 ] && ok "GitHub unreachable: preflight FAIL (exit 1)" || bad "c6 ($(head -3 "$W/ev-c6/results.txt" 2>/dev/null))"
grep -rlF "$PAT" "$W"/ev-* 2>/dev/null | grep -q . && bad "the credential leaked into evidence" || ok "no credential in any evidence file"
echo "p4-selftest: $fails failure(s); workdir $W"
exit $((fails > 0))
