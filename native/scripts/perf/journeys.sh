#!/usr/bin/env bash
# Runs the mobile perf journeys on a simulator signed in to the seeded hosts (hosts.sh), and
# writes one log per scenario with the app's `[perf]` lines. See README.md beside this file.
#
#   journeys.sh <out-dir> [scenario ...]     # default: every scenario
#
# Needs Maestro on PATH (navigation answers iOS's link prompt).
# Starts by resetting the hosts to their seeded snapshot (hosts.sh reset); NO_RESET=1 skips it.
# Env: UDID (required), RUNS (5), AWAY_S (10), APP (com.dcouple.pane.mobile),
#      LAUNCH_URL (how a cold launch opens the app: a dev client's Metro link, or empty for an
#      installed release build), PERF_ROOT (as hosts.sh).
# Then: node native/scripts/perf-table.mts --runs 5 <out-dir>/*.log
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:?usage: journeys.sh <out-dir> [scenario ...]}; shift
ROOT=${PERF_ROOT:-${PANE_SCRATCH_DIR:?set PERF_ROOT or PANE_SCRATCH_DIR}/perf.noindex}
UDID=${UDID:?set UDID to the simulator}
APP=${APP:-com.dcouple.pane.mobile}
RUNS=${RUNS:-5}
AWAY_S=${AWAY_S:-10}
LAUNCH_URL=${LAUNCH_URL:-}
mkdir -p "$OUT"

runpane() { HOME="$ROOT/home" node "$REPO/packages/runpane/dist/cli.js" "$@"; }
# HOST_A, HOST_B, PANE_A, PANE_B, TERMINAL_A, SESSION_A, CHAT_A, APPROVAL_A from the seeded hosts,
# read after the reset below.
fixture() { node "$REPO/native/scripts/perf/fixture.mjs" "$ROOT" "$@"; }

# iOS asks before opening a pane:// link; Maestro answers it.
open_link() {
  maestro --device "$UDID" test -e LINK="$1" "$REPO/native/.maestro/perf-open.yaml" >/dev/null 2>&1 \
    || echo "  opening $1 failed" >&2
}
background() { xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null; }
foreground() { xcrun simctl launch "$UDID" "$APP" >/dev/null; }
cold_launch() {
  xcrun simctl terminate "$UDID" "$APP" >/dev/null 2>&1 || true
  sleep 2
  # The dev client's own link opens without a prompt.
  if [ -n "$LAUNCH_URL" ]; then xcrun simctl openurl "$UDID" "$LAUNCH_URL"; else foreground; fi
}

# Writes the app's [perf] lines to <out>/<scenario>.log while the scenario runs.
capture_start() {
  xcrun simctl spawn "$UDID" log stream --style compact --level info \
    --predicate 'subsystem == "com.facebook.react.log" AND eventMessage CONTAINS "[perf]"' > "$OUT/$1.log" 2>/dev/null &
  CAPTURE=$!
  sleep 2
}
capture_stop() { sleep 1; kill "$CAPTURE" 2>/dev/null || true; wait "$CAPTURE" 2>/dev/null || true; }

tap() {
  maestro --device "$UDID" test -e ID="$1" "$REPO/native/.maestro/perf-tap.yaml" >/dev/null 2>&1 || echo "  tapping $1 failed" >&2
}
# Every scenario starts from a fresh launch, so screens from the last one never stay mounted below.
fresh() { cold_launch; sleep 15; }

# Parsa's repro (T1, T2): leave the app from a screen, change something on the host, come back.
returns() {
  local name=$1 link=$2 change=$3
  fresh
  [ -n "$link" ] && { open_link "$link"; sleep 8; }
  capture_start "$name"
  for _ in $(seq "$RUNS"); do
    background; sleep 3
    $change || echo "  the host change ($change) failed; this run has nothing new to show" >&2
    sleep "$((AWAY_S - 3))"
    foreground; sleep 10
  done
  capture_stop
}

# A first open: each run launches fresh, then opens the screen.
first_opens() {
  local name=$1 link=$2
  capture_start "$name"
  for _ in $(seq "$RUNS"); do fresh; open_link "$link"; sleep 8; done
  capture_stop
}

# A reopen: the screen was opened once this run; each run goes back with its own button and opens it again.
reopens() {
  local name=$1 link=$2 back=$3
  fresh
  open_link "$link"; sleep 8; tap "$back"; sleep 3
  capture_start "$name"
  for _ in $(seq "$RUNS"); do open_link "$link"; sleep 8; tap "$back"; sleep 3; done
  capture_stop
}

# What changes on the host while the phone is away, so the return has something new to show.
term_change() { runpane panels input --panel "$TERMINAL_A" --text "echo perf-change-$(date +%s)"$'\r' --yes --pane-dir "$ROOT/hostA" >/dev/null; }
chat_change() { fixture call hostA chat-tab:send "[\"$CHAT_A\",{\"operationId\":\"perf-$(date +%s)\",\"text\":\"A message sent while the phone was away\"}]" >/dev/null; }
count_change() { runpane panes create --repo "$ROOT/hostA-repo" --name "perf-extra-$(date +%s)" --tool-command 'bash --norc' --no-focus --no-pinned --yes --pane-dir "$ROOT/hostA" >/dev/null; }

scenario() {
  local terminal="pane://pane/$PANE_A?host=$HOST_A&panel=$TERMINAL_A" session="pane://session/$SESSION_A"
  case $1 in
    cold-launch)
      capture_start cold-launch
      for _ in $(seq "$RUNS"); do fresh; done
      capture_stop ;;
    return-home) returns return-home "" count_change ;;
    return-session-chat) returns return-session-chat "$session" chat_change ;;
    return-pane-terminal) returns return-pane-terminal "$terminal" term_change ;;
    open-terminal) first_opens open-terminal "$terminal" ;;
    reopen-terminal) reopens reopen-terminal "$terminal" terminal-back ;;
    open-session-chat) first_opens open-session-chat "$session" ;;
    reopen-session-chat) reopens reopen-session-chat "$session" terminal-back ;;
    open-approval)
      # Approval 2 of the seeded ones, then Next to the one after it.
      capture_start open-approval
      for _ in $(seq "$RUNS"); do fresh; open_link "pane:///approval/${APPROVAL_A:?no seeded approval}"; sleep 8; tap approval-next; sleep 6; done
      capture_stop ;;
    switch)
      fresh
      capture_start switch
      for _ in $(seq "$RUNS"); do tap machine-chip-Perf-B; sleep 10; tap machine-chip-Perf-A; sleep 10; done
      capture_stop
      # Back to All on Perf-A, where every other scenario starts.
      tap machine-chip-all; sleep 3 ;;
    *) echo "unknown scenario $1" >&2; exit 1 ;;
  esac
}

# The mark each scenario must log; without it the scenario measured the wrong thing (the phone on
# another machine, a screen that never opened), and its numbers must not be used.
expected_mark() {
  case $1 in
    cold-launch) echo 'launch home-fresh' ;;
    return-home) echo 'return home-fresh' ;;
    return-session-chat) echo 'return chat-live' ;;
    return-pane-terminal) echo 'return terminal-live' ;;
    open-terminal|reopen-terminal) echo 'terminal screen' ;;
    open-session-chat|reopen-session-chat) echo 'chat messages' ;;
    open-approval) echo 'approval card=' ;;
    switch) echo 'switch home-fresh' ;;
  esac
}

SCENARIOS=("$@")
[ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(cold-launch return-home return-session-chat return-pane-terminal open-terminal reopen-terminal open-session-chat reopen-session-chat open-approval switch)
# Every column starts from the same fixture: the returns add Panes, chat messages and terminal output.
[ "${NO_RESET:-}" = 1 ] || "$REPO/native/scripts/perf/hosts.sh" reset
eval "$(fixture ids)"
failed=0
for name in "${SCENARIOS[@]}"; do
  echo "$(date +%T) $name (load $(uptime | sed 's/.*load averages: //'))"
  scenario "$name"
  mark=$(expected_mark "$name")
  if ! grep -q "\[perf\] $mark" "$OUT/$name.log"; then
    echo "  FAILED: $name logged no '[perf] $mark'. Is the phone on Perf-A (pair with perf-pair.yaml), and did the screen open?" >&2
    failed=1
  fi
done
exit "$failed"

