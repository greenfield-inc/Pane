#!/usr/bin/env bash
# Writes the Expo fingerprint (native/fingerprint.config.js) of the checked-out
# head and of a base commit, for each platform, plus each side's runtimeVersion:
#   ci-native-fingerprint.sh <base-sha> <platform...>
# Output: $RUNNER_TEMP/{head,base}-<platform> and {head,base}-runtime.
# The base is fingerprinted with the head's expo-updates, so both sides use one
# fingerprint version, and a base without expo-updates still gets one.
set -euo pipefail

base_sha="$1"
shift
out="${RUNNER_TEMP:?RUNNER_TEMP must be set}"
cli="$PWD/native/node_modules/expo-updates/bin/cli.js"

fingerprint() {
  local side="$1"
  shift
  pnpm install --frozen-lockfile --ignore-scripts
  (
    cd native
    for platform in "$@"; do
      node "$cli" fingerprint:generate --platform "$platform" | jq -r .hash > "$out/$side-$platform"
    done
    jq -r .expo.runtimeVersion app.json > "$out/$side-runtime"
  )
}

fingerprint head "$@"
git worktree add "$out/base" "$base_sha"
(cd "$out/base" && fingerprint base "$@")
