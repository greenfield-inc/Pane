#!/usr/bin/env bash
# Build the cloud-dist artifacts for a pushed fork branch on a boat devbox, download them, and publish
# them as a GitHub PRE-RELEASE on the fork (tag rc-<sha8>). Runs on the operator machine (agentbox).
# Usage: scripts/cloud-dist/publish-release.sh --devbox <sandboxId> --ref <branch> [--skip-build]
# Env:   BOAT_HDR      curl header file with the boat Authorization header (default ~/rc-loop/secrets/boat.hdr)
#        RC_BIN        rc-loop helpers dir providing devbox.sh (default ~/rc-loop/bin)
#        FORK_REPO     GitHub repo for the release (default jamari-morrison/Pane). Never the upstream repo.
#        DIST_CURRENT  status file for the artifact URLs. Default: ~/rc-loop/results/dist-current.md for
#                      INTEGRATION_REF (rc/integration) only; any other branch writes dist-branch-<ref>.md so a
#                      feature-branch build never replaces the shared "current" artifacts.
# Prints the release URL. make-golden.sh fills the golden section of the same file.
set -euo pipefail
BOAT_HDR=${BOAT_HDR:-$HOME/rc-loop/secrets/boat.hdr}
RC_BIN=${RC_BIN:-$HOME/rc-loop/bin}
FORK_REPO=${FORK_REPO:-jamari-morrison/Pane}
INTEGRATION_REF=${INTEGRATION_REF:-rc/integration}
BOAT=https://boat.dev/api/v1
DEVBOX='' REF='' SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --devbox) DEVBOX=$2; shift 2;;
    --ref) REF=$2; shift 2;;
    --skip-build) SKIP_BUILD=1; shift;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[ -n "$DEVBOX" ] && [ -n "$REF" ] || { echo "usage: $0 --devbox <id> --ref <branch> [--skip-build]" >&2; exit 2; }
if [ "$REF" = "$INTEGRATION_REF" ]; then DEFAULT_STATUS=$HOME/rc-loop/results/dist-current.md
else DEFAULT_STATUS=$HOME/rc-loop/results/dist-branch-${REF//\//-}.md; fi
DIST_CURRENT=${DIST_CURRENT:-$DEFAULT_STATUS}
case "$FORK_REPO" in greenfield-inc/*) echo "refusing to publish to upstream $FORK_REPO" >&2; exit 2;; esac
REMOTE_OUT=/home/user/cloud-dist-out
REMOTE_LOG=/home/user/cloud-dist-build.log
log() { echo "publish: $(date -u +%H:%M:%S) $*" >&2; }

read_remote() { # path -> utf8 contents on stdout
  curl -sS -H @"$BOAT_HDR" --get --data-urlencode "path=$1" "$BOAT/sandboxes/$DEVBOX/files" |
    python3 -c 'import json,sys;d=json.load(sys.stdin);sys.stdout.write(d.get("content") or "")'
}

if [ "$SKIP_BUILD" = 0 ]; then
  log "building $REF on $DEVBOX"
  # Upload this checkout's build script so any ref builds (e.g. rc/integration before cloud-dist merged into it).
  python3 -c 'import json,sys,base64;print(json.dumps({"path":"rcl-cloud-dist/build-artifacts.sh","content":base64.b64encode(open(sys.argv[1],"rb").read()).decode(),"encoding":"base64"}))' \
    "$(dirname "$0")/build-artifacts.sh" |
    curl -sS -f -o /dev/null -X PUT -H @"$BOAT_HDR" -H 'Content-Type: application/json' --data-binary @- "$BOAT/sandboxes/$DEVBOX/files"
  "$RC_BIN/devbox.sh" bg "$DEVBOX" "$REF" \
    "rm -f $REMOTE_LOG; bash /home/user/rcl-cloud-dist/build-artifacts.sh $REMOTE_OUT > $REMOTE_LOG 2>&1; echo CLOUD_DIST_EXIT=\$? >> $REMOTE_LOG" >/dev/null
  sleep 20
  for _ in $(seq 1 120); do
    tail_txt=$(read_remote "$REMOTE_LOG" | tail -5)
    if grep -q '^CLOUD_DIST_EXIT=' <<<"$tail_txt"; then break; fi
    sleep 15
  done
  grep -q '^CLOUD_DIST_EXIT=0' <<<"$tail_txt" || { echo "$tail_txt" >&2; log "build failed (see $REMOTE_LOG on $DEVBOX)"; exit 1; }
fi

INFO=$(read_remote "$REMOTE_OUT/build-info.json")
VERSION=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["version"])' "$INFO")
COMMIT=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["commit"])' "$INFO")
SHA8=${COMMIT:0:8}
TAG="rc-$SHA8"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
printf '%s' "$INFO" > "$WORK/build-info.json"
remote_cmd() { # single-line shell command on the devbox -> stdout
  python3 -c 'import json,sys;print(json.dumps({"command":sys.argv[1],"timeoutSeconds":300}))' "$1" |
    curl -sS -X POST -H @"$BOAT_HDR" -H 'Content-Type: application/json' --data-binary @- "$BOAT/sandboxes/$DEVBOX/commands" |
    python3 -c 'import json,sys;d=json.load(sys.stdin);r=d.get("result",d);sys.stdout.write(r.get("stdout",""));sys.exit(r.get("exitCode",1))'
}
fetch() { # remote path -> local file. GET /artifacts caps a download at 50 MiB, so big files come in 45 MiB parts.
  local src=$1 dst=$2 parts
  parts=$(remote_cmd "set -e; rm -rf $REMOTE_OUT/.parts; mkdir $REMOTE_OUT/.parts; split -b 45M -d -a 3 $src $REMOTE_OUT/.parts/p.; ls $REMOTE_OUT/.parts")
  : > "$dst"
  for part in $parts; do
    curl -sS -f -H @"$BOAT_HDR" --get --data-urlencode "path=$REMOTE_OUT/.parts/$part" "$BOAT/sandboxes/$DEVBOX/artifacts" >> "$dst"
  done
}
for f in "pane_${VERSION}_amd64.deb" "runpane-${VERSION}.tgz" SHA256SUMS.txt; do
  log "downloading $f"
  fetch "$REMOTE_OUT/$f" "$WORK/$f"
done
(cd "$WORK" && sha256sum -c SHA256SUMS.txt >&2)

NOTES="Runpane Cloud fork build of $COMMIT (branch $REF). Not an upstream release.
Version: $VERSION
Install the daemon: \`sudo apt-get install -y ./pane_${VERSION}_amd64.deb\`
Install the CLI: \`npm i -g https://github.com/$FORK_REPO/releases/download/$TAG/runpane-${VERSION}.tgz\`"
if gh release view "$TAG" --repo "$FORK_REPO" >/dev/null 2>&1; then
  log "release $TAG exists; replacing assets"
  gh release upload "$TAG" --repo "$FORK_REPO" --clobber "$WORK"/* >&2
else
  gh release create "$TAG" --repo "$FORK_REPO" --prerelease --target "$COMMIT" \
    --title "Runpane Cloud rc $SHA8" --notes "$NOTES" "$WORK"/* >&2
fi
# Anonymous download check (the fork is public, so sandboxes fetch without credentials) + status file.
DIST_CURRENT="$DIST_CURRENT" FORK_REPO="$FORK_REPO" INTEGRATION_REF="$INTEGRATION_REF" \
  "$(dirname "$0")/record-release.sh" "$TAG"
