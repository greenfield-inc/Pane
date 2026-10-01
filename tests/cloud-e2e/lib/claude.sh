# shellcheck shell=bash
# Give the sandbox's Pane daemon a usable Claude Code, so agent-panel gates can run a real agent.
# The token reaches the daemon through a 0600 EnvironmentFile drop-in on the daemon's user unit; it is
# never on a command line, in sandbox metadata, or in evidence.
#   E2E_CLAUDE_TOKEN_CMD  command printing the OAuth token (default ~/rc-loop/bin/claude-token.sh)
#   E2E_CLAUDE=0          disable (agent checks are then recorded as SKIP)

claude_available() {
  [ "${E2E_CLAUDE:-1}" = 1 ] && [ -x "${E2E_CLAUDE_TOKEN_CMD:-$HOME/rc-loop/bin/claude-token.sh}" ]
}

# sandbox_claude_setup <sandbox-id> <trusted-dir>...
sandbox_claude_setup() {
  local sid="$1"; shift
  local envf="$E2E_SECRETS/claude.env"
  (umask 077; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$("${E2E_CLAUDE_TOKEN_CMD:-$HOME/rc-loop/bin/claude-token.sh}")" > "$envf")
  cl boat put "$sid" "$envf" "rcl/claude.env" || return 1
  shred -u "$envf"
  local trusted; trusted=$(printf '"%s",' "$@"); trusted="[${trusted%,}]"
  sbx "$sid" 400 <<SH
set -e
chmod 600 /home/user/rcl/claude.env
command -v claude >/dev/null || sudo npm i -g @anthropic-ai/claude-code >/home/user/rcl/claude-install.log 2>&1
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude.json')
d = json.load(open(p)) if os.path.exists(p) else {}
d['hasCompletedOnboarding'] = True
d['bypassPermissionsModeAccepted'] = True
d.setdefault('projects', {})
for t in $trusted:
    d['projects'].setdefault(t, {})['hasTrustDialogAccepted'] = True
json.dump(d, open(p, 'w'))
sp = os.path.expanduser('~/.claude/settings.json')
os.makedirs(os.path.dirname(sp), exist_ok=True)
st = json.load(open(sp)) if os.path.exists(sp) else {}
st['skipDangerousModePermissionPrompt'] = True
json.dump(st, open(sp, 'w'))
PY
unit=\$(systemctl --user list-units --all --plain --no-legend 'pane-remote-daemon*' | awk '{print \$1}' | head -1)
unit=\${unit:-pane-remote-daemon.service}
mkdir -p ~/.config/systemd/user/\$unit.d
printf '[Service]\nEnvironmentFile=/home/user/rcl/claude.env\n' > ~/.config/systemd/user/\$unit.d/rc-loop-claude.conf
systemctl --user daemon-reload
systemctl --user restart \$unit
echo "claude \$(claude --version 2>/dev/null | head -1); unit \$unit"
SH
}
