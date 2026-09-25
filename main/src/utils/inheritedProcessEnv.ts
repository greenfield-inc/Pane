import type { PtyHostSpawnOpts } from '../ptyHost/types';

/**
 * Variables a running Claude Code session sets for its own child processes.
 * When Pane is launched from inside such a session, they leak into every
 * terminal Pane spawns: agents there treat themselves as nested child sessions
 * (transcript saving off) and receive the parent's messaging socket and token.
 * User configuration under the same prefix (e.g. CLAUDE_CODE_USE_BEDROCK) is
 * deliberately not listed, so it still passes through.
 */
const PARENT_AGENT_SESSION_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
]);

/**
 * Pane's process environment as a string map for spawned shells and commands:
 * undefined values dropped, parent agent-session markers removed.
 */
export function inheritedProcessEnv(env: NodeJS.ProcessEnv = process.env): PtyHostSpawnOpts['env'] {
  const result: PtyHostSpawnOpts['env'] = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || PARENT_AGENT_SESSION_KEYS.has(key)) continue;
    result[key] = value;
  }
  return result;
}

/** Interactive terminals advertise color; don't inherit a launcher’s NO_COLOR flag. */
export function interactiveTerminalEnv(env: NodeJS.ProcessEnv = process.env): PtyHostSpawnOpts['env'] {
  const result = inheritedProcessEnv(env);
  delete result.NO_COLOR;
  return result;
}
