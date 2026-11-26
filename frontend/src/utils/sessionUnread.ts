import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

/**
 * Whether a Session has a message from its own agent the person has not read: the agent finished
 * a turn (`agentRepliedAt`, stored by the host) after the person last opened the Session
 * (`openedAt`, its chat Pane's last view). Pane lines, worker tabs and the person's own messages
 * never set `agentRepliedAt`, so they never make a Session unread.
 *
 * Compared to the second: the host stores a view as SQLite's CURRENT_TIMESTAMP, which drops the
 * milliseconds, so a reply in the same second as the open reads as read.
 */
export function sessionIsUnread(session: Pick<OrchestrationSessionRecord, 'agentRepliedAt' | 'openedAt'>): boolean {
  if (!session.agentRepliedAt) return false;
  const repliedMs = Date.parse(session.agentRepliedAt);
  if (Number.isNaN(repliedMs)) return false;
  const openedMs = session.openedAt ? Date.parse(session.openedAt) : Number.NaN;
  if (Number.isNaN(openedMs)) return true;
  return Math.floor(repliedMs / 1000) > Math.floor(openedMs / 1000);
}
