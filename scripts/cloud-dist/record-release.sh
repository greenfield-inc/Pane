#!/usr/bin/env bash
# Record a published fork prerelease rc-<sha8> in the dist status file: checks that the assets download
# anonymously (sandboxes fetch without credentials), verifies the CLI tarball's sha256, and rewrites the
# artifacts block. Used by publish-release.sh (devbox builds) and for releases built by the fork's
# rc-integration.yml workflow (GitHub Actions). Runs on the operator machine (agentbox).
# Usage: scripts/cloud-dist/record-release.sh <tag>
# Env:   FORK_REPO     default jamari-morrison/Pane. Never the upstream repo.
#        DIST_CURRENT  status file. Default: ~/rc-loop/results/dist-current.md when the build's ref is
#                      INTEGRATION_REF (rc/integration), else dist-branch-<ref>.md.
set -euo pipefail
FORK_REPO=${FORK_REPO:-jamari-morrison/Pane}
INTEGRATION_REF=${INTEGRATION_REF:-rc/integration}
TAG=${1:?usage: $0 <tag>}
case "$FORK_REPO" in greenfield-inc/*) echo "refusing upstream $FORK_REPO" >&2; exit 2;; esac
log() { echo "record: $(date -u +%H:%M:%S) $*" >&2; }
DL="https://github.com/$FORK_REPO/releases/download/$TAG"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -sSfL -o "$WORK/build-info.json" "$DL/build-info.json"
curl -sSfL -o "$WORK/SHA256SUMS.txt" "$DL/SHA256SUMS.txt"
read -r VERSION COMMIT REF < <(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["version"],d["commit"],d.get("ref") or "")' "$WORK/build-info.json")
[ "${COMMIT:0:8}" = "${TAG#rc-}" ] || { log "build-info commit $COMMIT does not match $TAG"; exit 1; }
curl -sSfL -o "$WORK/runpane-${VERSION}.tgz" "$DL/runpane-${VERSION}.tgz"
(cd "$WORK" && grep " runpane-${VERSION}.tgz\$" SHA256SUMS.txt | sha256sum -c - >&2)
code=$(curl -sS -o /dev/null -w '%{http_code}' -L -r 0-0 "$DL/pane_${VERSION}_amd64.deb")
log "anonymous .deb download check: HTTP $code"
case "$code" in 200|206) ;; *) log "release asset not publicly downloadable"; exit 1;; esac

if [ "$REF" = "$INTEGRATION_REF" ]; then DEFAULT_STATUS=$HOME/rc-loop/results/dist-current.md
else DEFAULT_STATUS=$HOME/rc-loop/results/dist-branch-${REF//\//-}.md; fi
DIST_CURRENT=${DIST_CURRENT:-$DEFAULT_STATUS}
python3 - "$DIST_CURRENT" "$TAG" "$VERSION" "$COMMIT" "$REF" "$DL" "$FORK_REPO" <<'PY'
import sys, re, datetime, os
path, tag, version, commit, ref, dl, repo = sys.argv[1:]
block = f"""<!-- artifacts:start -->
## Artifacts (updated {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')})
- Release: https://github.com/{repo}/releases/tag/{tag} (prerelease)
- Commit: `{commit}` (branch `{ref}`), version `{version}`
- Pane .deb (linux x64): {dl}/pane_{version}_amd64.deb
- runpane CLI tarball: {dl}/runpane-{version}.tgz  (`npm i -g <url>`)
- Checksums: {dl}/SHA256SUMS.txt ; build info: {dl}/build-info.json
<!-- artifacts:end -->"""
text = open(path).read() if os.path.exists(path) else "# dist-current (m2-dist; always the latest published fork build)\n\n<!-- golden:start -->\n## Golden image\n(not built yet)\n<!-- golden:end -->\n"
if "<!-- artifacts:start -->" in text:
    text = re.sub(r"<!-- artifacts:start -->.*?<!-- artifacts:end -->", lambda _: block, text, flags=re.S)
else:
    text = text.replace("<!-- golden:start -->", block + "\n\n<!-- golden:start -->", 1)
open(path, "w").write(text)
PY
log "updated $DIST_CURRENT"
echo "https://github.com/$FORK_REPO/releases/tag/$TAG"
