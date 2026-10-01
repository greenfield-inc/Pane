#!/bin/bash
# payload-check.sh — assert the golden payload (installed as /usr/local/sbin/rp-golden-payload-check). Run as root.
# Identity strip-list checks live in rp-golden-check (packages/runpane/src/cloud/bootstrap/assets/golden-check.sh).
# Usage: sudo U=user bash payload-check.sh <expected-pane-version>
U="${U:-user}"; H=$(getent passwd "$U" | cut -d: -f6); H="${H:-/home/$U}"; EXPECT="$1"
fail=0; pass(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; fail=1; }
pv=$(cd / && sudo -u "$U" HOME="$H" /usr/bin/pane --ozone-platform=headless --disable-gpu --version 2>/dev/null | tail -1)
[ "$pv" = "$EXPECT" ] && pass "pane --version = $pv" || bad "pane --version '$pv' != '$EXPECT'"
command -v tailscale >/dev/null && pass "tailscale installed ($(tailscale version | head -1))" || bad "tailscale missing"
ls -d /opt/ms-playwright/chromium-* >/dev/null 2>&1 && pass "playwright chromium in /opt/ms-playwright" || bad "no chromium in /opt/ms-playwright"
grep -q '^PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' /etc/environment && pass "PLAYWRIGHT_BROWSERS_PATH in /etc/environment" || bad "PLAYWRIGHT_BROWSERS_PATH not in /etc/environment"
[ $fail = 0 ] && echo "RESULT PASS (payload)" || echo "RESULT FAIL (payload)"; exit $fail
