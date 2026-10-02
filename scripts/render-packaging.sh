#!/usr/bin/env bash
# Renders the Homebrew cask and winget manifests in packaging/ for one release.
#
#   scripts/render-packaging.sh <version> <SHA256SUMS> <out-dir>
#
# Fills @VERSION@ and each @SHA256:<release file>@ from a `sha256sum` listing of
# the release files. Fails when a template names a file the listing lacks.
set -euo pipefail

version="$1"
sums="$2"
out="$3"
root="$(cd "$(dirname "$0")/.." && pwd)"

status=0
for template in "$root"/packaging/homebrew/Casks/*.rb "$root"/packaging/winget/*.yaml; do
  text="$(sed "s/@VERSION@/$version/g" "$template")"
  while read -r hash name; do
    text="${text//@SHA256:${name#\*}@/$hash}"
  done < "$sums"
  relative="${template#"$root"/packaging/}"
  if grep -q '@SHA256:' <<< "$text"; then
    echo "$relative: no checksum for $(grep -o '@SHA256:[^@]*@' <<< "$text" | cut -d : -f 2 | tr -d @ | sort -u | xargs)" >&2
    status=1
    continue
  fi
  mkdir -p "$out/$(dirname "$relative")"
  printf '%s\n' "$text" > "$out/$relative"
  echo "rendered $relative"
done
exit "$status"
