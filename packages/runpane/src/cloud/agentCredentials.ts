import type { SandboxHandle } from './provider';
import type { CloudCredentials } from './store';

/**
 * Gives a cloud Session's agents a way to sign in: an Anthropic API key or
 * Claude token in the environment. The saved key or Claude token reaches the Pane daemon's user unit through a 0600
 * EnvironmentFile drop-in, so agent panels inherit it. It is never on a command line, in sandbox
 * metadata or in output, and Claude Code's first-run prompts are pre-answered for the Session.
 */

const ENV_FILE = '/home/user/.runpane-cloud/agent.env';
const DROP_IN_NAME = 'runpane-cloud-agent.conf';

export type AgentCredentialKind = 'anthropic-api-key' | 'claude-oauth-token';

function agentCredentialKinds(credentials: CloudCredentials): AgentCredentialKind[] {
  const kinds: AgentCredentialKind[] = [];
  if (credentials.anthropic) kinds.push('anthropic-api-key');
  if (credentials.claude) kinds.push('claude-oauth-token');
  return kinds;
}

/** Writes the env file and restarts the daemon with it. Resolves the kinds placed (none: nothing to do). */
export async function placeAgentCredentials(
  sandbox: SandboxHandle,
  credentials: CloudCredentials,
  trustedDirs: readonly string[],
): Promise<AgentCredentialKind[]> {
  const kinds = agentCredentialKinds(credentials);
  if (kinds.length === 0) return kinds;
  const lines: string[] = [];
  if (credentials.anthropic) lines.push(`ANTHROPIC_API_KEY=${credentials.anthropic.apiKey}`);
  if (credentials.claude) lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${credentials.claude.oauthToken}`);
  // ~/.runpane-cloud is bootstrap's 0700 state dir, so the file is private from the moment it lands.
  await sandbox.writeFile(ENV_FILE, `${lines.join('\n')}\n`);

  const trusted = JSON.stringify([...new Set(['/home/user', ...trustedDirs])]);
  const script = `set -e
chmod 600 ${ENV_FILE}
python3 - <<'PY'
import json, os
env = dict(line.split('=', 1) for line in open('${ENV_FILE}').read().splitlines() if '=' in line)
p = os.path.expanduser('~/.claude.json')
d = json.load(open(p)) if os.path.exists(p) else {}
d['hasCompletedOnboarding'] = True
d['bypassPermissionsModeAccepted'] = True
key = env.get('ANTHROPIC_API_KEY')
if key:
    # Claude Code asks once whether to use a key from the environment; approve this one (it stores the last 20 characters).
    responses = d.setdefault('customApiKeyResponses', {})
    approved = responses.setdefault('approved', [])
    if key[-20:] not in approved:
        approved.append(key[-20:])
    responses.setdefault('rejected', [])
d.setdefault('projects', {})
for t in ${trusted}:
    d['projects'].setdefault(t, {})['hasTrustDialogAccepted'] = True
old = os.umask(0o077)
json.dump(d, open(p, 'w'))
sp = os.path.expanduser('~/.claude/settings.json')
os.makedirs(os.path.dirname(sp), exist_ok=True)
st = json.load(open(sp)) if os.path.exists(sp) else {}
st['skipDangerousModePermissionPrompt'] = True
json.dump(st, open(sp, 'w'))
os.umask(old)
PY
unit=pane-remote-daemon.service
mkdir -p ~/.config/systemd/user/$unit.d
printf '[Service]\\nEnvironmentFile=${ENV_FILE}\\n' > ~/.config/systemd/user/$unit.d/${DROP_IN_NAME}
systemctl --user daemon-reload
systemctl --user restart $unit
echo "RP_AGENT_ENV ok"
`;
  const result = await sandbox.runScript(script, { timeoutSeconds: 120 });
  if (result.exitCode !== 0 || !result.stdout.includes('RP_AGENT_ENV ok')) {
    throw new Error(`Placing the agent credentials failed (exit ${String(result.exitCode)}).`);
  }
  return kinds;
}
