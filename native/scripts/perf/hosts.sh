#!/usr/bin/env bash
# Starts or stops the two isolated hosts the mobile perf journeys run against, each behind a
# proxy that adds DELAY_MS each way (default 100: a 200 ms round trip). See README.md here.
#
#   hosts.sh up      # build main and runpane first (pnpm run build:main; pnpm --filter runpane build)
#   hosts.sh seed    # 68 Panes, 7 approvals, a full terminal and a 200-message chat on A; 12 Panes on B
#   hosts.sh down
#
# Everything lives under PERF_ROOT (default $PANE_SCRATCH_DIR/perf.noindex). The phone pairs with
# $PERF_ROOT/<host>.phone-code, which points at the proxy.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
ROOT=${PERF_ROOT:-${PANE_SCRATCH_DIR:?set PERF_ROOT or PANE_SCRATCH_DIR}/perf.noindex}
DELAY_MS=${DELAY_MS:-100}
HOSTS=("hostA 47161 47171 Perf-A" "hostB 47162 47172 Perf-B")
mkdir -p "$ROOT/home"
export HOME="$ROOT/home"   # keeps the hosts away from this machine's real agent configs

up() {
  for spec in "${HOSTS[@]}"; do
    read -r name port proxy label <<<"$spec"
    local dir="$ROOT/$name"
    if [ ! -f "$dir/config.json" ]; then
      node "$REPO/main/dist/main/src/daemon/setupRemoteHostCli.js" --pane-dir "$dir" --label "$label" \
        --listen-port "$port" --prefer-tunnel ssh --no-install-service --no-tailscale-serve >/dev/null
      # Session chats are chat tabs, as on a fresh desktop install.
      node -e 'const f=process.argv[1];const c=JSON.parse(require("fs").readFileSync(f));c.chatTabsEnabled=true;require("fs").writeFileSync(f,JSON.stringify(c,null,2))' "$dir/config.json"
    fi
    # The code carries the token; rewriting setup's code keeps the token and points the phone at the proxy.
    node "$REPO/main/dist/main/src/daemon/setupRemoteHostCli.js" --pane-dir "$dir" --label "$label" \
      --listen-port "$port" --prefer-tunnel ssh --no-install-service --no-tailscale-serve | grep '^pane-remote://' > "$ROOT/$name.code"
    node -e '
      const [code, port] = process.argv.slice(1);
      const body = JSON.parse(Buffer.from(code.trim().slice(14), "base64url"));
      body.baseUrl = `http://127.0.0.1:${port}`; delete body.tunnel;
      console.log("pane-remote://" + Buffer.from(JSON.stringify(body)).toString("base64url"));' "$(cat "$ROOT/$name.code")" "$proxy" > "$ROOT/$name.phone-code"
    if ! curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null; then
      PANE_DIR="$dir" PANE_CHAT_TEST_AGENT="$REPO/main/src/services/chatTabs/testing/scriptedAgent.mjs" SCRIPTED_AGENT_STORE="$ROOT/agent-store" \
        nohup "$REPO/node_modules/.bin/electron" "$REPO/main/dist/main/src/daemon/headless.js" --pane-dir "$dir" > "$ROOT/$name.log" 2>&1 &
      echo $! > "$ROOT/$name.pid"
    fi
    if [ ! -f "$ROOT/$name.proxy.pid" ] || ! kill -0 "$(cat "$ROOT/$name.proxy.pid")" 2>/dev/null; then
      nohup node "$REPO/native/scripts/perf/delay-proxy.mjs" "$proxy" "$port" "$DELAY_MS" > /dev/null 2>&1 &
      echo $! > "$ROOT/$name.proxy.pid"
    fi
    for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$port/health" >/dev/null && break; sleep 2; done
    echo "$label: host :$port, phone through :$proxy (${DELAY_MS} ms each way), code $ROOT/$name.phone-code"
  done
}

seed() {
  node "$REPO/native/scripts/perf/seed.mjs" --pane-dir "$ROOT/hostA" --code "$ROOT/hostA.code" --panes 68 --approvals 7 --chat --big-terminal
  node "$REPO/native/scripts/perf/seed.mjs" --pane-dir "$ROOT/hostB" --code "$ROOT/hostB.code" --panes 12
}

down() {
  for spec in "${HOSTS[@]}"; do
    read -r name _ <<<"$spec"
    for pid in "$ROOT/$name.proxy.pid" "$ROOT/$name.pid" "$ROOT/$name.notify.pids"; do
      [ -f "$pid" ] && while read -r p; do kill "$p" 2>/dev/null || true; done < "$pid"
      rm -f "$pid"
    done
  done
}

case "${1:-}" in
  up) up ;;
  seed) seed ;;
  down) down ;;
  *) echo "Usage: hosts.sh up|seed|down" >&2; exit 1 ;;
esac
