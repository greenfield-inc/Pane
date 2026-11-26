/**
 * Did a Session agent's turn end with a message the person can read? (T-117 D-1.) Only such a turn
 * makes its Session unread, whatever started it: the person, a worker report, a `[From Pane …]`,
 * watcher or Autopilot line. A turn of tool calls or thinking alone, or an empty reply, does not.
 *
 * - Chat tabs: the turn's last assistant message (after the last user message) has non-blank text.
 * - Terminal tabs running Claude or Codex: the agent's own transcript has non-blank reply text
 *   stamped at or after the turn began (transcripts record only text, never tool calls).
 * - Any other terminal agent has no transcript Pane can read, so its turn counts as a reply, as
 *   it did before; so does a Claude or Codex turn whose transcript Pane cannot find.
 */

import type { AgentChatMessage } from '../../../shared/types/agentChat';
import { agentTranscripts } from './agentTranscript';
import { panelTranscriptLocator } from './agentTranscript/panelLocator';
import { getChatTabManager } from './chatTabs';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';

/** Asks whether `panelId`'s turn, begun at `turnStartedAtMs`, ended with text the person can read. */
export type ReplyProbe = (panelId: string, turnStartedAtMs: number) => Promise<boolean>;

/** The turn is everything after the last user message; it ended with text when its last assistant message has some. */
export function chatTurnEndedWithText(messages: Iterable<AgentChatMessage>): boolean {
  let last: AgentChatMessage | undefined;
  for (const message of messages) last = message.role === 'user' ? undefined : message;
  return last?.parts.some(part => part.type === 'text' && part.text.trim() !== '') ?? false;
}

/** A Claude transcript is written as the turn goes; its last line can land just after the tab goes idle. */
const TRANSCRIPT_SETTLE_MS = 1_500;

const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

/** The real probe; `worktreeOf` gives a Pane's working directory, where its agent's transcript is kept. */
export function createReplyProbe(worktreeOf: (paneId: string) => string | undefined): ReplyProbe {
  return async (panelId, turnStartedAtMs) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;
    try {
      if (panel.type === 'chat') return chatTurnEndedWithText(getChatTabManager().messages(panelId));
      const agentType = terminalPanelManager.getTerminalSnapshot(panelId)?.agentType;
      const locator = panelTranscriptLocator(panel, worktreeOf(panel.sessionId), agentType);
      if (!locator) return true;
      if ((await agentTranscripts.assistantTextSince(locator, turnStartedAtMs)) !== false) return true;
      await wait(TRANSCRIPT_SETTLE_MS);
      return (await agentTranscripts.assistantTextSince(locator, turnStartedAtMs)) !== false;
    } catch (error) {
      // Unsure reads as a reply: a missed message is worse than an extra bold.
      console.warn(`[Sessions] Could not tell whether panel ${panelId}'s turn ended with a message:`, error);
      return true;
    }
  };
}
