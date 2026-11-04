#!/bin/sh
# Switch the installed better-sqlite3 build between Node (unit tests) and
# Electron (the app) inside the OSS Scanner image, which has no network to
# rebuild it. `save <runtime>` is used once by .oss-scanner/Dockerfile.
set -e
store=/opt/pane-sqlite
module="$(cd /src/main && node -p "require('path').dirname(require.resolve('better-sqlite3-multiple-ciphers/package.json'))")/build/Release/better_sqlite3.node"
case "$1 $2" in
  "save node" | "save electron")
    mkdir -p "$store"
    cp "$module" "$store/$2.node"
    ;;
  "node " | "electron ")
    cp "$store/$1.node" "$module"
    echo "better-sqlite3: $1 build installed"
    ;;
  *)
    echo "usage: pane-sqlite-abi node|electron" >&2
    exit 2
    ;;
esac
