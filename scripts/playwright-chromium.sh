#!/usr/bin/env bash
# Installs Playwright's Chromium for CI, from the restored cache when it hit,
# within a bound, so a stalled download fails the job in minutes. No
# --with-deps: the Ubuntu runner image already has the libraries Chromium loads.
set -euo pipefail

limit=300
status=0
timeout "${limit}" pnpm exec playwright install chromium || status=$?
if [ "${status}" -eq 124 ]; then
  echo "::error title=Playwright install stalled::pnpm exec playwright install chromium did not finish in ${limit} s, so the job stops here instead of hanging. The browser download from Playwright's CDN stalled; https://www.githubstatus.com may show why."
fi
exit "${status}"
