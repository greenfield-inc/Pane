/**
 * Parent-agent session markers that must never reach a spawned agent.
 *
 * When Pane is launched from inside a Claude Code session, it inherits that
 * session's identity. Claude Code sees `CLAUDE_CODE_CHILD_SESSION` in a child
 * process and turns transcript persistence off. Nothing is written, so a later
 * resume fails with "No conversation found with session ID".
 *
 * Every agent Pane spawns is a new top-level session, so the launching agent's
 * markers are always wrong to pass along.
 */
const INHERITED_AGENT_SESSION_VARS = new Set([
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
]);

/** Copy an environment, dropping the launching agent's session identity. */
export function stripInheritedAgentSession(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !INHERITED_AGENT_SESSION_VARS.has(entry[0])
    )
  );
}
