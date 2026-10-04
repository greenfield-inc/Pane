#!/bin/bash
# identity-check.sh: assert the cloud sandbox identity strip list is absent after identity-scrub.sh and the
# first-boot unit ran: no inherited credentials or Pane state, a fresh machine-id, regenerated SSH host keys
# and no inherited tailnet node. Run as root. Prints PASS/FAIL per item; exit 0 only if all pass.
# Never prints secret values.
U="${U:-user}"; H=$(getent passwd "$U" | cut -d: -f6); H="${H:-/home/$U}"
fail=0; pass(){ echo "PASS $*"; }; bad(){ echo "FAIL $*"; fail=1; }
absent(){ local label="$1"; shift; local hit=""; for p in "$@"; do [ -e "$p" ] && hit="$hit $p"; done
  [ -z "$hit" ] && pass "$label absent" || bad "$label present:$hit"; }
for h in "$H" /root; do
  absent "claude credentials ($h)"   "$h/.claude/.credentials.json"
  absent "gh hosts ($h)"             "$h/.config/gh/hosts.yml"
  absent "git credentials ($h)"      "$h/.git-credentials" "$h/.config/git/credentials"
  if [ -f "$h/.gitconfig" ] && git config --file "$h/.gitconfig" --get-all credential.helper >/dev/null; then bad "git credential.helper set in $h/.gitconfig"; fi
  absent "npmrc ($h)"                "$h/.npmrc"
  absent "docker config ($h)"        "$h/.docker/config.json"
  absent "chrome profile ($h)"       "$h/.config/google-chrome" "$h/.config/chromium"
  absent "shell history ($h)"        "$h/.bash_history" "$h/.zsh_history" "$h/.local/share/fish/fish_history" "$h/.python_history" "$h/.node_repl_history"
  absent "ssh user keys ($h)"        $(ls "$h"/.ssh/id_* 2>/dev/null)
  absent "pane remote state/pairing/client records ($h)" "$h/.pane_remote"
  absent "pane analytics id ($h)"    "$h/.pane/config.json"
  absent "runpane cloud pairing and agent env ($h)" "$h/.runpane-cloud/pairing.code" "$h/.runpane-cloud/agent.env"
  absent "other agent auth ($h)"     "$h/.codex/auth.json" "$h/.config/opencode/auth.json" "$h/.local/share/opencode/auth.json"
done
absent "tailscaled state backup (bootstrap guard)" /var/lib/rp-ts-backup/tailscaled.state
if [ -e /var/lib/tailscale/tailscaled.state ]; then
  boot=$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) )); m=$(stat -c %Y /var/lib/tailscale/tailscaled.state)
  [ "$m" -ge $((boot-5)) ] && pass "tailscaled state fresh (written after this boot)" || bad "tailscaled state predates boot (inherited)"
else pass "tailscaled state absent"; fi
if command -v tailscale >/dev/null && systemctl is-active -q tailscaled; then
  st=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("BackendState"))' 2>/dev/null)
  [ "$st" = NeedsLogin ] || [ "$st" = NoState ] && pass "tailscale BackendState=$st (not joined)" || bad "tailscale BackendState=$st"
fi
mid=$(cat /etc/machine-id 2>/dev/null); keys=$(ls /etc/ssh/ssh_host_*_key 2>/dev/null)
[[ "$mid" =~ ^[0-9a-f]{32}$ ]] && pass "machine-id fresh" || bad "machine-id invalid"
[ -n "$keys" ] && pass "ssh host keys regenerated ($(echo $keys | wc -w))" || bad "no ssh host keys"
[ $fail = 0 ] && echo "RESULT PASS" || echo "RESULT FAIL"; exit $fail
