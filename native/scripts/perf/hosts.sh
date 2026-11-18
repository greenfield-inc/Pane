#!/usr/bin/env bash
# Starts, seeds and resets the two isolated hosts the mobile perf journeys run against, each
# behind a proxy that adds DELAY_MS each way (default 100: a 200 ms round trip). See README.md.
#
#   hosts.sh up      # build main and runpane first (pnpm run build:main; pnpm --filter runpane build)
#   hosts.sh seed    # once: 68 Panes and a 200-message Session chat on A, 12 Panes on B; then a snapshot
#   hosts.sh reset   # before each column of numbers: back to the snapshot, so every run starts the same
#   hosts.sh down
#
# Each start also asks 7 approvals from Panes and fills a terminal past the 2,500-line cap: a
# question's asker and a terminal's shell do not survive a host restart.
#
# Everything lives under PERF_ROOT (default $PANE_SCRATCH_DIR/perf.noindex). The phone pairs with
# $PERF_ROOT/<host>.phone-code, which points at the proxy. The hosts send no analytics and no
# push notifications, and keep their own browser profile.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
ROOT=${PERF_ROOT:-${PANE_SCRATCH_DIR:?set PERF_ROOT or PANE_SCRATCH_DIR}/perf.noindex}
DELAY_MS=${DELAY_MS:-100}
HOSTS=("hostA 47161 47171 Perf-A" "hostB 47162 47172 Perf-B")
FIXTURE=(hostA hostB hostA-repo hostB-repo agent-store)
mkdir -p "$ROOT/home"
export HOME="$ROOT/home"   # keeps the hosts and runpane away from this machine's real agent configs and ~/.pane
# Push keys in this shell would deliver real notifications to whatever pairs with the hosts.
for key in $(env | grep -E '^PANE_(APNS|FCM)_' | cut -d= -f1); do unset "$key"; done

configure() {
  node -e '
    const fs = require("fs"); const file = process.argv[1]; const config = JSON.parse(fs.readFileSync(file));
    config.chatTabsEnabled = true;                       // Session chats are chat tabs, as on a fresh install
    config.analytics = { ...(config.analytics ?? {}), enabled: false };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));' "$1"
}

start() {
  for spec in "${HOSTS[@]}"; do
    read -r name port proxy label <<<"$spec"
    local dir="$ROOT/$name"
    # Setup mints a new token each time it runs, so it runs once per host, and its code is kept
    # with the fixture (and its snapshot): a reset leaves the phone's pairing valid.
    if [ ! -f "$dir/config.json" ]; then
      mkdir -p "$dir"
      node "$REPO/main/dist/main/src/daemon/setupRemoteHostCli.js" --pane-dir "$dir" --label "$label" \
        --listen-port "$port" --prefer-tunnel ssh --no-install-service --no-tailscale-serve | grep '^pane-remote://' > "$dir/connection-code"
    fi
    configure "$dir/config.json"
    cp "$dir/connection-code" "$ROOT/$name.code"
    # The phone's copy points at the proxy instead of the host.
    node -e '
      const [code, port] = process.argv.slice(1);
      const body = JSON.parse(Buffer.from(code.trim().slice(14), "base64url"));
      body.baseUrl = `http://127.0.0.1:${port}`; delete body.tunnel;
      console.log("pane-remote://" + Buffer.from(JSON.stringify(body)).toString("base64url"));' "$(cat "$ROOT/$name.code")" "$proxy" > "$ROOT/$name.phone-code"
    if ! curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null; then
      PANE_DIR="$dir" PANE_CHAT_TEST_AGENT="$REPO/main/src/services/chatTabs/testing/scriptedAgent.mjs" SCRIPTED_AGENT_STORE="$ROOT/agent-store" \
        nohup "$REPO/node_modules/.bin/electron" "$REPO/main/dist/main/src/daemon/headless.js" --pane-dir "$dir" \
        --user-data-dir="$dir/chromium-user-data" > "$ROOT/$name.log" 2>&1 &
      echo $! > "$ROOT/$name.pid"
    fi
    if [ ! -f "$ROOT/$name.proxy.pid" ] || ! kill -0 "$(cat "$ROOT/$name.proxy.pid")" 2>/dev/null; then
      nohup node "$REPO/native/scripts/perf/delay-proxy.mjs" "$proxy" "$port" "$DELAY_MS" > /dev/null 2>&1 &
      echo $! > "$ROOT/$name.proxy.pid"
    fi
    local up=0
    for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null && { up=1; break; }; sleep 2; done
    if [ "$up" != 1 ]; then echo "$label did not answer on :$port within 2 minutes; see $ROOT/$name.log" >&2; exit 1; fi
    echo "$label: host :$port, phone through :$proxy (${DELAY_MS} ms each way), code $ROOT/$name.phone-code"
  done
}

# What a restart loses: the waiting approvals and the full terminal.
prime() {
  [ -f "$ROOT/hostA.notify.pids" ] && while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$ROOT/hostA.notify.pids"
  rm -f "$ROOT/hostA.notify.pids"
  node "$REPO/native/scripts/perf/fixture.mjs" "$ROOT" close-approvals
  node "$REPO/native/scripts/perf/seed.mjs" --pane-dir "$ROOT/hostA" --code "$ROOT/hostA.code" --approvals 7 --big-terminal
}

down() {
  for spec in "${HOSTS[@]}"; do
    read -r name _ <<<"$spec"
    for pid in "$ROOT/$name.proxy.pid" "$ROOT/$name.pid" "$ROOT/$name.notify.pids"; do
      [ -f "$pid" ] && while read -r p; do kill "$p" 2>/dev/null || true; done < "$pid"
      rm -f "$pid"
    done
  done
  # Wait for the hosts to let go of their data before anything copies it.
  for spec in "${HOSTS[@]}"; do
    read -r _ port _ <<<"$spec"
    for _ in $(seq 1 30); do lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done
  done
}

snapshot() {
  down
  rm -rf "$ROOT/snapshot"; mkdir -p "$ROOT/snapshot"
  # APFS clones: instant, and no extra disk until a file changes.
  for item in "${FIXTURE[@]}"; do [ -e "$ROOT/$item" ] && cp -cR "$ROOT/$item" "$ROOT/snapshot/$item"; done
  echo "snapshot taken"
}

case "${1:-}" in
  up) start; prime ;;
  seed)
    start
    node "$REPO/native/scripts/perf/seed.mjs" --pane-dir "$ROOT/hostA" --code "$ROOT/hostA.code" --panes 68 --chat
    node "$REPO/native/scripts/perf/seed.mjs" --pane-dir "$ROOT/hostB" --code "$ROOT/hostB.code" --panes 12
    snapshot; start; prime ;;
  reset)
    [ -d "$ROOT/snapshot" ] || { echo "No snapshot: run hosts.sh seed first." >&2; exit 1; }
    down
    for item in "${FIXTURE[@]}"; do rm -rf "${ROOT:?}/$item"; [ -e "$ROOT/snapshot/$item" ] && cp -cR "$ROOT/snapshot/$item" "$ROOT/$item"; done
    start; prime ;;
  down) down ;;
  *) echo "Usage: hosts.sh up|seed|reset|down" >&2; exit 1 ;;
esac
