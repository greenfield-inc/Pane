#!/usr/bin/env bash
# One shot for an integration head: build + publish the fork prerelease, build the golden image, prove it LIVE,
# then prune older integration goldens rp-loop-golden-<sha8> (keeps the newest KEEP_GOLDENS, default 2).
# Only prunes after an rc/integration run; branch goldens (rp-loop-golden-br-*) are never pruned here.
# Usage: scripts/cloud-dist/release.sh --devbox <sandboxId> --ref <branch>   (e.g. --ref rc/integration)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BOAT_HDR=${BOAT_HDR:-$HOME/rc-loop/secrets/boat.hdr}
RC_BIN=${RC_BIN:-$HOME/rc-loop/bin}
KEEP_GOLDENS=${KEEP_GOLDENS:-2}
url=$("$HERE/publish-release.sh" "$@" | tail -1)
tag=${url##*/}
"$HERE/make-golden.sh" --tag "$tag"
case " $* " in *" ${INTEGRATION_REF:-rc/integration} "*) ;; *) echo "release: done $tag (branch build; no pruning)"; exit 0;; esac
curl -sS -H @"$BOAT_HDR" https://boat.dev/api/v1/named-snapshots |
  python3 -c '
import json,sys
import re
snaps=[s for s in json.load(sys.stdin).get("snapshots",[]) if re.fullmatch(r"rp-loop-golden-[0-9a-f]{8}", s["name"]) and s.get("status")=="ready"]
snaps.sort(key=lambda s: s["createdAt"], reverse=True)
print("\n".join(s["name"] for s in snaps[int(sys.argv[1]):]))' "$KEEP_GOLDENS" |
  while read -r old; do
    [ -n "$old" ] || continue
    echo "release: pruning named snapshot $old"
    CONFIRM="$old" "$RC_BIN/boat.sh" DELETE "/named-snapshots/$old" | head -1
  done
echo "release: done $tag (see ${DIST_CURRENT:-$HOME/rc-loop/results/dist-current.md})"
