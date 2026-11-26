/**
 * + on a controller: open the next thing waiting on you, in the one shared
 * order (shared/controller/needsYou.ts). Approvals and questions come from
 * the Approvals queue; Panes whose agent is blocked come from the attention
 * inbox's derivation, which runs whether or not its sidebar list is shown.
 */
import { nextNeedsYou, type NeedsYouItem } from '../../../shared/controller/needsYou';
import { countsAsWaiting } from '../../../shared/types/notify';
import { openApprovals } from '../components/approvals/approvalsNavigation';
import { focusActiveTabSoon } from '../services/regionFocus';
import { useAttentionInboxStore } from '../stores/attentionInboxStore';
import { selectNotifyItems, useNotifyStore } from '../stores/notifyStore';
import { useSessionStore } from '../stores/sessionStore';

interface WaitingEntry extends NeedsYouItem {
  open: () => void;
}

let lastOpened: string | null = null;

function waitingEntries(): WaitingEntry[] {
  const items = selectNotifyItems(useNotifyStore.getState()).filter(countsAsWaiting);
  const asked = new Set(items.map(item => item.source.paneId).filter(Boolean));
  const entries: WaitingEntry[] = items.map(item => ({
    id: `item:${item.id}`,
    kind: item.ui === 'approve' ? 'permission' : 'question',
    since: item.createdAt,
    open: () => openApprovals(item.id),
  }));
  const sessions = useSessionStore.getState().sessions;
  for (const paneId of useAttentionInboxStore.getState().members) {
    if (asked.has(paneId)) continue;
    const pane = sessions.find(session => session.id === paneId);
    entries.push({
      id: `pane:${paneId}`,
      kind: 'terminal',
      since: pane?.lastActivity ? Date.parse(pane.lastActivity) || 0 : 0,
      open: () => {
        void useSessionStore.getState().setActiveSession(paneId);
        focusActiveTabSoon();
      },
    });
  }
  return entries;
}

/** Opens the next waiting item; false when nothing waits. */
export function openNextNeedsYou(): boolean {
  const next = nextNeedsYou(waitingEntries(), lastOpened);
  if (!next) return false;
  lastOpened = next.id;
  next.open();
  return true;
}
