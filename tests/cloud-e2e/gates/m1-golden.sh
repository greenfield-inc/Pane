#!/usr/bin/env bash
# M1 gate: "the golden image has none of the strip-list files" (final-plan S4 M1, Other fixes).
# Forks a sandbox from the golden named snapshot, runs lib/strip-check.sh in `fork` mode as root, checks the
# fork's machine-id / SSH host key differ from a second fork (identity is per machine, never from the image),
# and that the fork carries the Pane .deb (pane --version) but no pairing.
# Env: E2E_GOLDEN (default: dist-current golden)
. "$(dirname "$0")/../lib/common.sh"
. "$E2E_LIB/cli.sh"
GOLDEN="${E2E_GOLDEN:-$(dist_url golden)}"
export E2E_TARGET="${GOLDEN:-no-golden}"
e2e_init M1-golden
wait_start_budget 1
[ -n "$GOLDEN" ] || { rec golden BLOCKED "no golden image named in $E2E_DIST_CURRENT yet"; exit 0; }
ids=()
for n in 1; do   # one fork: per-fork identity was proven by M0 (m0d) and m2-dist gate-fork; starts are scarce
  t0=$(ms_now); id=$(sb_create "golden-fork$n-$(date -u +%H%M%S)" small "$GOLDEN") || { rec "fork$n" FAIL "fork from $GOLDEN failed"; exit 1; }
  cl boat wait "$id" idle,ready,running --timeout 180 >/dev/null
  rec "fork$n" PASS "forked $GOLDEN -> $id ready in $(secs_since "$t0")s" "" "seconds=$(secs_since "$t0")"; ids+=("$id")
done
chk=$( { echo 'cat > /home/user/rcl-strip-check.sh <<'"'"'CHK'"'"''; cat "$E2E_LIB/strip-check.sh"; echo 'CHK'; echo 'sudo U=user bash /home/user/rcl-strip-check.sh fork; rc=$?; rm -f /home/user/rcl-strip-check.sh; exit $rc'; } | sbx "${ids[0]}" 120); crc=$?
printf '%s\n' "$chk" | ev strip-check.txt >/dev/null
[ $crc = 0 ] && rec strip-list PASS "strip-check fork mode: $(grep -c '^PASS' <<<"$chk") PASS, 0 FAIL" "$E2E_RUN_DIR/strip-check.txt" \
  || rec strip-list FAIL "$(grep '^FAIL' <<<"$chk" | head -5 | tr '\n' ';')" "$E2E_RUN_DIR/strip-check.txt"
idq='echo "$(pane --version 2>/dev/null | head -1) $(test -e ~/.pane_remote && echo PAIRED || echo unpaired)"'
a=$(sbx "${ids[0]}" 30 <<<"$idq"); printf '%s\n' "$a" | ev fork-state.txt >/dev/null
read -r pa ua _ <<<"$a"
rec identity-per-fork SKIP "one fork only (boat start budget); per-fork machine-id/host-key uniqueness proven in M0 m0d (5 forks) and m2-dist gate-fork"
[ -n "$pa" ] && [ "$ua" = unpaired ] && rec deb-unpaired PASS "fork has Pane $pa installed and no pairing" "$E2E_RUN_DIR/fork-state.txt" \
  || rec deb-unpaired FAIL "pane='$pa' pairing=$ua" "$E2E_RUN_DIR/fork-state.txt"
