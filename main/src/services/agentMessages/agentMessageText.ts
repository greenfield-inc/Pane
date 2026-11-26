import { messageRef } from '../../../../shared/types/agentMessages';

/**
 * The rule every agent instruction carries (the Session AGENTS.md, the pane-orchestrator and
 * pane-orchestration skills; runpane agent-context has the same words in its workspace rules).
 */
export const AGENT_REPLY_RULE = 'A message from another agent (another Session\'s orchestrator, a worker, Autopilot) ends with a reply line, `Reply with runpane reply M-12 "…"`: answer it with `runpane reply M-12 "…"`, never only in your own chat, which the sender never sees. Its reply reaches you as `reply: M-12 → "…"`.';

/**
 * Every line Pane adds to an agent-to-agent message (T-104). Tabs read them as plain text, so each
 * names the message and the command that answers it, as to-do lines do.
 */

/** The last line of a message one agent sent another: how to answer so the sender sees it. */
function replyRouteLine(number: number, senderName: string): string {
  return `Reply with runpane reply ${messageRef(number)} "…": it reaches ${senderName}, who never sees your own chat.`;
}

/** The message as Pane types it: the sender's text, then the reply line. */
export function withReplyRoute(body: string, number: number, senderName: string): string {
  return `${body.replace(/\s+$/u, '')}\n\n${replyRouteLine(number, senderName)}`;
}

/** A reply as Pane types it into the original sender's tab. */
export function replyLine(original: number, reply: number, body: string, fromName: string): string {
  return `reply: ${messageRef(original)} → "${body.trim()}" (from ${fromName}) [${messageRef(reply)}; answer it with runpane reply ${messageRef(reply)} "…"]`;
}
