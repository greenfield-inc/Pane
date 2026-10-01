#!/bin/bash
# provision.sh — install the Runpane Cloud golden-image payload on a fresh boat sandbox. Run as root.
#   - the fork's Pane .deb (daemon binary only: no `runpane install daemon`, so no pairing/client records)
#   - Tailscale, installed but NOT joined (golden-scrub.sh deletes the state it writes)
#   - Playwright Chromium in /opt/ms-playwright (~/.cache is not kept in boat snapshots; see m0d-golden.md)
#   - /usr/local/sbin/rp-golden-check (bootstrap's golden-check.sh), /usr/local/sbin/rp-golden-payload-check,
#     and /etc/rp-golden.json metadata for per-sandbox bootstrap
# Usage: sudo bash provision.sh <deb-url> <golden-check.sh> <payload-check.sh> <metadata-json> [playwright-version]
set -euo pipefail
DEB_URL="$1"; CHECK_SRC="$2"; PAYLOAD_SRC="$3"; META="$4"; PW_VERSION="${5:-1.54.1}"
export DEBIAN_FRONTEND=noninteractive PATH=/usr/local/bin:$PATH
t0=$(date +%s); step(){ echo "provision: +$(( $(date +%s) - t0 ))s $*"; }

step "pane .deb"
curl -fsSL --retry 3 -o /var/tmp/pane.deb "$DEB_URL"
apt-get update -qq
apt-get install -y -qq /var/tmp/pane.deb >/dev/null
rm -f /var/tmp/pane.deb
dpkg-query -W -f='provision: installed ${Package} ${Version}\n' pane

step "tailscale (not joined)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
tailscale version | head -1

step "playwright ${PW_VERSION} chromium -> /opt/ms-playwright"
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
npx -y "playwright@${PW_VERSION}" install --with-deps chromium >/dev/null
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
grep -q '^PLAYWRIGHT_BROWSERS_PATH=' /etc/environment || echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" >> /etc/environment
ls "$PLAYWRIGHT_BROWSERS_PATH"
rm -rf /root/.npm/_npx /root/.cache/ms-playwright

step "golden check + metadata"
install -m 755 "$CHECK_SRC" /usr/local/sbin/rp-golden-check
install -m 755 "$PAYLOAD_SRC" /usr/local/sbin/rp-golden-payload-check
printf '%s\n' "$META" > /etc/rp-golden.json
chmod 644 /etc/rp-golden.json
step "done"
