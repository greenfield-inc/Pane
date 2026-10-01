#!/usr/bin/env bash
# Build the Runpane Cloud distribution artifacts for the current checkout:
#   pane_<version>_amd64.deb      Linux x64 Pane (daemon + desktop) .deb
#   runpane-<version>.tgz         npm pack of packages/runpane (install with `npm i -g <url>`)
#   SHA256SUMS.txt, build-info.json
# Run from the repository root on a Linux x64 build host (a boat devbox) after `pnpm install`.
# The artifacts carry a fork prerelease version, <package version>-rc.<commit time>.g<sha8>, so `pane --version`
# and `runpane --version` identify the exact commit. Nothing is committed or published here.
# Usage: scripts/cloud-dist/build-artifacts.sh [out-dir]   (default: dist-cloud)
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
OUT=$(realpath -m "${1:-dist-cloud}")
SHA=$(git rev-parse --short=8 HEAD)
BASE_VERSION=$(node -p "require('./package.json').version")
# rc.<commit UTC time>.g<sha8>: the timestamp makes versions sort by commit time under both semver and dpkg
# (upgrade-on-wake installs a newer .deb with apt; a bare sha would sort randomly and look like a downgrade).
# The "g" prefix keeps the sha identifier alphanumeric (an all-digit sha with a leading 0 is invalid semver).
STAMP=$(TZ=UTC0 git show -s --format=%cd --date=format-local:%Y%m%d%H%M%S HEAD)
VERSION="${BASE_VERSION}-rc.${STAMP}.g${SHA}"
if ! git diff-index --quiet HEAD --; then
  echo "cloud-dist: working tree is dirty; refusing to label a build with ${SHA}" >&2
  exit 1
fi

rm -rf "$OUT" dist-electron
mkdir -p "$OUT"
log() { echo "cloud-dist: $(date -u +%H:%M:%S) $*"; }

log "building frontend + main for ${VERSION}"
pnpm run build:frontend
pnpm run build:main
pnpm run inject-build-info

# Native modules must match Electron's ABI. A build host that also runs vitest (like the integrator's devbox)
# has better-sqlite3 compiled for plain Node; packaging that ships a daemon that can't open its DB
# (NODE_MODULE_VERSION 137 vs 145). Rebuild for Electron, and put the host's original binary back afterwards so
# its Node test runs keep working.
SQLITE_DIR=$(cd main && node -p "require('path').dirname(require.resolve('better-sqlite3-multiple-ciphers/package.json'))")
NATIVE_BAK=$(mktemp -d)
[ -d "$SQLITE_DIR/build" ] && cp -a "$SQLITE_DIR/build" "$NATIVE_BAK/"
restore_native() { [ -d "$NATIVE_BAK/build" ] && { rm -rf "$SQLITE_DIR/build"; cp -a "$NATIVE_BAK/build" "$SQLITE_DIR/"; }; rm -rf "$NATIVE_BAK"; }
trap restore_native EXIT
log "rebuilding native modules for Electron"
pnpm run electron:rebuild

log "packaging deb (x64)"
# extraMetadata.version sets app.getVersion() (pane --version) and the deb version without editing package.json.
pnpm exec electron-builder --linux deb --x64 --publish never \
  -c.extraMetadata.version="$VERSION"
# Load every locally compiled native module with the packaged Electron's own Node (catches ABI mismatches).
APP=dist-electron/linux-unpacked
native=$(find "$APP/resources/app.asar.unpacked" -path '*/build/Release/*.node')
[ -n "$native" ] || { echo "cloud-dist: no build/Release native modules found in $APP" >&2; exit 1; }
for n in $native; do
  ELECTRON_RUN_AS_NODE=1 "$APP/pane" -e 'process.dlopen({ exports: {} }, process.argv[1])' "$(realpath "$n")" \
    || { echo "cloud-dist: packaged native module does not load under Electron: $n" >&2; exit 1; }
  log "native ok: ${n#"$APP"/resources/}"
done
DEB=$(ls dist-electron/*.deb | head -1)
cp "$DEB" "$OUT/pane_${VERSION}_amd64.deb"

log "packing runpane CLI"
pnpm --filter runpane build
STAGE=$(mktemp -d)
cp -R packages/runpane/dist packages/runpane/README.md packages/runpane/package.json "$STAGE/"
node -e '
const fs = require("fs"); const p = process.argv[1] + "/package.json";
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.version = process.argv[2]; delete pkg.devDependencies; delete pkg.scripts;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");' "$STAGE" "$VERSION"
(cd "$STAGE" && npm pack --silent --pack-destination "$OUT" >/dev/null)
rm -rf "$STAGE"

node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({
  version: process.argv[2], commit: process.argv[3], builtAt: new Date().toISOString(),
  node: process.version, deb: process.argv[4], runpane: process.argv[5], ref: process.argv[6],
}, null, 2) + "\n");' "$OUT/build-info.json" "$VERSION" "$(git rev-parse HEAD)" \
  "pane_${VERSION}_amd64.deb" "runpane-${VERSION}.tgz" "$(git rev-parse --abbrev-ref HEAD)"
(cd "$OUT" && sha256sum *.deb *.tgz > SHA256SUMS.txt)

# Sanity: the packaged app must report the fork version.
dpkg-deb -f "$OUT/pane_${VERSION}_amd64.deb" Version
ls -la "$OUT"
log "done ${VERSION}"
