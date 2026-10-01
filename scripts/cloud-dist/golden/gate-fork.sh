#!/bin/bash
# gate-fork.sh — LIVE gate on a sandbox forked from the golden named snapshot. Run as the login user (sudo available).
# 1. identity: run the first-boot regen explicitly (forks are not rebooted), then rp-golden-check fork mode
# 2. daemon: the installed fork .deb runs a headless Pane daemon on loopback and answers /health
# 3. chromium: Playwright's Chromium from /opt/ms-playwright launches
# Usage: bash gate-fork.sh <expected-pane-version> <golden-machine-id> <golden-hostkey-sha>
set -u
EXPECT="$1"; GMID="$2"; GHK="$3"; fail=0
F="--ozone-platform=headless --disable-gpu"
sudo /usr/local/sbin/rp-firstboot-identity
sudo U="$(id -un)" GOLDEN_MID="$GMID" GOLDEN_HOSTKEY_SHA="$GHK" /usr/local/sbin/rp-golden-check fork || fail=1
sudo U="$(id -un)" /usr/local/sbin/rp-golden-payload-check "$EXPECT" || fail=1
echo "INFO golden metadata: $(tr -d '\n' < /etc/rp-golden.json)"

D=$(mktemp -d "$HOME/.pane-gate.XXXXXX"); P=42199
t0=$(date +%s%3N)
timeout 120 pane $F --remote-setup --pane-dir "$D" --prefer-tunnel manual --base-url "http://127.0.0.1:$P" --listen-port "$P" \
  --no-install-service --no-tailscale-serve --label rp-golden-gate --json > "$D.setup.json" 2> "$D.setup.err" \
  && echo "PASS remote-setup (no service, no tailscale)" || { echo "FAIL remote-setup (exit $?; 124 = hung 120 s):"; grep -m3 -E 'Error|NODE_MODULE_VERSION' "$D.setup.err"; fail=1; }
setsid nohup pane $F --daemon-headless --pane-dir "$D" > "$D.log" 2>&1 < /dev/null &
health=""
for _ in $(seq 1 60); do health=$(curl -fsS "http://127.0.0.1:$P/health" 2>/dev/null) && break; sleep 0.5; done
if [ -n "$health" ]; then
  echo "PASS daemon /health in $(( $(date +%s%3N) - t0 ))ms: $health"
  pid=$(pgrep -u "$(id -u)" -f -- "--daemon-headless --pane-dir $D" | head -1)
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
  echo "INFO daemon pid=$pid exe=$exe version=$(pane $F --version 2>/dev/null | tail -1)"
  # boat's lazy restore hydrates forked files in the background and then swaps the finished file into place;
  # a daemon started before that keeps the moved-aside inode under /var/lib/ascii-lazy/retired/<original path>.
  case "$exe" in
    /opt/Pane/*) echo "PASS daemon runs the installed .deb ($exe)";;
    /var/lib/ascii-lazy/retired/opt/Pane/*) echo "PASS daemon runs the installed .deb (lazily restored copy: $exe)";;
    *) echo "FAIL daemon exe '$exe'"; fail=1;;
  esac
  hv=$(printf '%s' "$health" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null)
  [ -n "$hv" ] && { [ "$hv" = "$EXPECT" ] && echo "PASS /health version = $hv" || { echo "FAIL /health version $hv != $EXPECT"; fail=1; }; }
else
  echo "FAIL daemon /health not reachable; log tail:"; tail -20 "$D.log"; fail=1
fi
pkill -u "$(id -u)" -f -- "--pane-dir $D" 2>/dev/null; sleep 1
[ $fail = 0 ] && rm -rf "$D" "$D".*   # keep the logs on failure (see --keep-gate)

PW=$(python3 -c 'import json;print(json.load(open("/etc/rp-golden.json")).get("playwright","1.54.1"))')
t0=$(date +%s%3N)
if (cd /tmp && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright timeout 180 npx -y "playwright@$PW" screenshot --browser chromium "data:text/html,<h1>rp</h1>" /tmp/rp-gate.png >/dev/null 2>&1) && [ -s /tmp/rp-gate.png ]; then
  echo "PASS chromium screenshot via /opt/ms-playwright in $(( $(date +%s%3N) - t0 ))ms"
else echo "FAIL chromium screenshot"; fail=1; fi
rm -f /tmp/rp-gate.png
[ $fail = 0 ] && echo "GATE PASS" || echo "GATE FAIL"; exit $fail
