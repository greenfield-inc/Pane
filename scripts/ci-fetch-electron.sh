#!/usr/bin/env bash
# Installs Electron's binary into node_modules/electron (CI only; see
# .github/actions/fetch-electron). The download is retried, because GitHub's
# release downloads return 5xx for hours at a time.
set -euo pipefail

attempts="${CI_FETCH_ELECTRON_ATTEMPTS:-4}"
delay=10
for attempt in $(seq 1 "$attempts"); do
  if node node_modules/electron/install.js; then
    # require('electron') must now resolve without downloading anything.
    node -e "require('fs').accessSync(require('electron'))"
    exit 0
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "::error title=Electron download failed::node node_modules/electron/install.js failed ${attempts} times. GitHub's release downloads may be down; rerun the job when https://www.githubstatus.com/ is green."
    exit 1
  fi
  echo "::warning title=Electron download retried::Attempt ${attempt} of ${attempts} failed; retrying in ${delay}s."
  sleep "$delay"
  delay=$((delay * 2))
done
