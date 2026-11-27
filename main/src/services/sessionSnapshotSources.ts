import type { PaneEventSink } from '../core/eventSink';
import type { ChatTabManager } from './chatTabs/manager';
import type { OrchestrationSessionManager } from './orchestrationSessionManager';
import type { SessionSnapshotSources } from './sessionSnapshots';
import { SESSION_LIST_SUMMARY } from '../../../shared/types/orchestrationSession';
import { SESSION_SNAPSHOT_CHANGED_CHANNEL, type SessionSnapshotChanged } from '../../../shared/types/sessionSnapshot';
import { decodeSessionPanelLayout, type SessionPanelLayout, type ToolPanel } from '../../../shared/types/panels';
import { PaneError } from '../../../shared/paneError';

/** The parts of this Pane a snapshot reads. Each is only read: none creates a tab, starts an agent or writes. */
export interface HostSnapshotReaders {
  sessions: Pick<OrchestrationSessionManager, 'list'>;
  panels: { getPanelsForSession(paneId: string): ToolPanel[]; getPanel(panelId: string): ToolPanel | undefined };
  chats: () => Pick<ChatTabManager, 'view'>;
  /** A Pane's stored layout as saved, or null. */
  storedLayout: (paneId: string) => string | null;
  events: () => PaneEventSink;
}

/** What a snapshot reads on this machine: the reads `panels:list`, `panels:get-layout` and a read-only chat view use. */
export function hostSnapshotSources(readers: HostSnapshotReaders): SessionSnapshotSources {
  return {
    sessions: async () => (await readers.sessions.list(SESSION_LIST_SUMMARY)).sessions,
    tabs: paneId => readers.panels.getPanelsForSession(paneId),
    panel: panelId => readers.panels.getPanel(panelId),
    layout: paneId => parseStoredPanelLayout(paneId, readers.storedLayout(paneId)),
    chat: (panelId, limit) => {
      try {
        // `false`: a snapshot shows the chat as it is and never starts its agent.
        return readers.chats().view(panelId, limit, false);
      } catch (error) {
        if (error instanceof PaneError && error.code === 'CHAT_PANEL_MISSING') return undefined;
        throw error;
      }
    },
    announce: (sessionId, revision) => {
      const notice: SessionSnapshotChanged = { sessionId, revision };
      readers.events().send(SESSION_SNAPSHOT_CHANGED_CHANNEL, notice);
    },
  };
}

/** A Pane's stored split layout; a corrupt one reads as none, so it never stops a Pane opening. */
export function parseStoredPanelLayout(paneId: string, raw: string | null): SessionPanelLayout | null {
  if (!raw) return null;
  try {
    // The same decoder reads each desktop's own layout memory.
    const parsed = decodeSessionPanelLayout(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Reported below.
  }
  console.warn('[Panels] Corrupt panel_layout JSON for session', paneId);
  return null;
}
