#!/bin/bash
# Runs IN a Session: one snapshot of everything the ports acceptance compares (read-only).
# usage: state.sh [tag]
set -uo pipefail
TAG="${1:-state}"
RP=$(command -v runpane || true); [ -x "$HOME/.pane_remote/bin/runpane" ] && RP="$HOME/.pane_remote/bin/runpane"
echo "### $TAG $(date -u +%FT%TZ) boot=$(cut -c1-8 /proc/sys/kernel/random/boot_id) up=$(uptime -s) pane=$(dpkg-query -W -f='${Version}' pane 2>/dev/null)"
echo "### tailscale serve status --json"; sudo -n tailscale serve status --json 2>&1
echo "### tailscale funnel status"; out=$(sudo -n tailscale funnel status 2>&1); echo "${out:-<empty>}"
echo "### AllowFunnel in serve config: $(sudo -n tailscale serve status --json 2>/dev/null | grep -c AllowFunnel)"
echo "### nft ruleset sha256 (tailscale0 input policy)"; sudo -n nft list ruleset 2>/dev/null | sha256sum | cut -c1-16
echo "### nft rp tables"; sudo -n nft list ruleset 2>/dev/null | awk '/^table/{p=($0 ~ /rp_/)} p'
echo "### ~/.runpane-cloud/ports.json ($(stat -c %a "$HOME/.runpane-cloud/ports.json" 2>/dev/null))"; cat "$HOME/.runpane-cloud/ports.json" 2>/dev/null || echo "<none>"
echo "### runpane port list --json"; env -u PANE_SESSION_ID "$RP" port list --json 2>&1
echo "### listeners"; ss -ltnp 2>/dev/null | awk 'NR==1 || /127.0.0.1|0.0.0.0|\[::/' | cut -c1-160
echo "### daemon log (ports:)"; grep -h "ports:" "$HOME"/.pane_remote/logs/pane-*.log 2>/dev/null | tail -25
echo "### serve guard events"; tail -3 /var/lib/rp-cloud/serve-events.log 2>/dev/null
echo "### agent notes blocks"; for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md"; do printf '%s ports-block=%s\n' "$f" "$(grep -c 'runpane-cloud-ports:start' "$f" 2>/dev/null || true)"; done
sed -n '/runpane-cloud-ports:start/,/runpane-cloud-ports:end/p' "$HOME/.claude/CLAUDE.md" 2>/dev/null | head -12
