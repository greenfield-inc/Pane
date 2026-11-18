#!/usr/bin/env bash
# Installs Electron's binary into node_modules/electron (CI only; see
# .github/actions/fetch-electron). The binary comes from the Actions cache; on a
# cache miss it is downloaded once, and a failed download fails the job.
set -euo pipefail

node node_modules/electron/install.js
# require('electron') must now resolve without downloading anything.
node -e "require('fs').accessSync(require('electron'))"
