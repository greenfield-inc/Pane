#!/usr/bin/env bash
# sb-create-retry.sh <name-suffix> <type> [from-named-snapshot]: $RC_BIN/sb-create.sh, but waits out boat's
# account-wide start limit (HTTP 429 rate_limited: 12/min, 60/hour, 200/day shared by every create/fork/resume)
# instead of failing mid-pipeline. Other errors fail at once. Env: START_WAIT_MAX_S (default 3600), START_WAIT_STEP_S (default 120).
# Before every attempt it asks $RC_BIN/starts-left.sh (rc-loop GUARDS "BOAT START BUDGET"): exit 3 = hour window used up -> wait;
# exit 4 = day remaining below the reserve -> refuse (record the need in ~/rc-loop/ledger/start-requests.md instead).
set -uo pipefail
RC_BIN=${RC_BIN:-$HOME/rc-loop/bin}
MAX=${START_WAIT_MAX_S:-3600}; STEP=${START_WAIT_STEP_S:-120}; waited=0
while :; do
  if [ -x "$RC_BIN/starts-left.sh" ]; then
    budget=$("$RC_BIN/starts-left.sh" 2>&1); brc=$?
    if [ "$brc" = 4 ]; then echo "sb-create-retry: refusing, day start reserve reached ($budget); see GUARDS 'BOAT START BUDGET'" >&2; exit 4; fi
    if [ "$brc" = 3 ]; then
      if [ "$waited" -ge "$MAX" ]; then echo "sb-create-retry: hour start window still exhausted after ${waited}s ($budget)" >&2; exit 1; fi
      echo "sb-create-retry: $budget; waiting ${STEP}s" >&2; sleep "$STEP"; waited=$((waited + STEP)); continue
    fi
  fi
  err=$(mktemp)
  if id=$("$RC_BIN/sb-create.sh" "$@" 2>"$err"); then rm -f "$err"; echo "$id"; exit 0; fi
  msg=$(cat "$err"); rm -f "$err"
  if ! grep -q -E '429|rate_limited' <<<"$msg"; then echo "$msg" >&2; exit 1; fi
  if [ "$waited" -ge "$MAX" ]; then echo "sb-create-retry: still rate limited after ${waited}s: $msg" >&2; exit 1; fi
  echo "sb-create-retry: boat start limit hit (rate_limited); retrying in ${STEP}s (waited ${waited}s of ${MAX}s)" >&2
  sleep "$STEP"; waited=$((waited + STEP))
done
