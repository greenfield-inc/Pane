#!/usr/bin/env bash
# Side-by-side smoke for a macOS desktop test build (rc-desktop.yml).
#
# Installs the released upstream Pane into /Applications and opens it, then opens
# the test app with `open` (what a double-click does). PASS means both keep
# running, the test build's data and Chromium profile are in ~/.pane_<name>, and it
# wrote nothing into ~/.pane. Writes results.txt and a screenshot to OUT_DIR.
#
# Usage: desktop-side-by-side-smoke-mac.sh <test .app> <expected version> <released Pane .zip> [name] [out dir]
set -uo pipefail

TEST_APP=$1
EXPECTED_VERSION=$2
INSTALLED_ZIP=$3
NAME=${4:-cloudtest}
OUT_DIR=${5:-smoke}
mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/results.txt"
: >"$RESULTS"
failed=0

check() { # name ok detail
  local verdict=PASS
  if [ "$2" != 1 ]; then verdict=FAIL; failed=1; fi
  echo "$verdict $1: $3" | tee -a "$RESULTS"
}
wait_for() { # seconds command...
  local seconds=$1; shift
  for _ in $(seq 1 "$((seconds / 2))"); do "$@" && return 0; sleep 2; done
  "$@"
}
has_files() { [ -n "$(find "$1" -maxdepth 1 -type f 2>/dev/null | head -1)" ]; }
ok() { if "$@" >/dev/null 2>&1; then echo 1; else echo 0; fi; }

installed_dir="$HOME/.pane"
test_dir="$HOME/.pane_$NAME"
test_exe="$TEST_APP/Contents/MacOS/Pane"

version=$("$test_exe" --version 2>/dev/null | tail -1)
check version "$([ "$version" = "$EXPECTED_VERSION" ] && echo 1 || echo 0)" "got '$version', want '$EXPECTED_VERSION'"
check version-touches-no-data "$(ok test ! -e "$test_dir")" "$test_dir absent after --version"
check codesign "$(ok codesign --verify --deep "$TEST_APP")" "$(codesign -dv "$TEST_APP" 2>&1 | grep -E '^(Identifier|Signature)' | tr '\n' ' ')"

ditto -x -k "$INSTALLED_ZIP" /Applications
open /Applications/Pane.app
wait_for 180 has_files "$installed_dir"
check installed-running "$(ok pgrep -f '/Applications/Pane.app/Contents/MacOS/Pane')" "files in $installed_dir"
# The installed Pane writes openrouter-prices.json itself some seconds after startup: list after it.
wait_for 90 test -e "$installed_dir/openrouter-prices.json" || true
sleep 15
installed_before=$(ls -A "$installed_dir" | sort)

open "$TEST_APP"
test_ready() { has_files "$test_dir" && [ -d "$test_dir/chromium-profile" ]; }
wait_for 180 test_ready
sleep 20
check test-data-dir "$(ok test_ready)" "$test_dir: $(ls -A "$test_dir" 2>/dev/null | tr '\n' ' ')"
check test-still-running "$(ok pgrep -f "$test_exe")" "test app alive 20 s after its data dir appeared"
check installed-still-running "$(ok pgrep -f '/Applications/Pane.app/Contents/MacOS/Pane')" "released Pane alive"
screencapture -x "$OUT_DIR/side-by-side.png" 2>/dev/null || echo "screenshot failed"
added=$(comm -13 <(echo "$installed_before") <(ls -A "$installed_dir" | sort) | tr '\n' ' ')
check installed-data-dir-untouched "$([ -z "$added" ] && [ ! -e "$installed_dir/chromium-profile" ] && echo 1 || echo 0)" "new entries in $installed_dir: [$added]"

pkill -f "$test_exe" || true
pkill -f '/Applications/Pane.app/Contents/MacOS/Pane' || true

if [ "$failed" = 0 ]; then echo "RESULT PASS" | tee -a "$RESULTS"; else echo "RESULT FAIL" | tee -a "$RESULTS"; exit 1; fi
