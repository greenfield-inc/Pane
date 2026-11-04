import { lazy, useMemo } from 'react';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import type { ToolPanel } from '../../../../shared/types/panels';
import { isSessionChat } from '../../components/chatTab/sessionChat';
import { useSessionWorkers } from '../../components/chatTab/sessionWorkers';
import type { ChatTurnActions } from '../../components/chatTab/ChatTurns';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

const ChatTabPanel = lazy(() => import('../../components/chatTab/ChatTabPanel'));

interface RemoteChatTabProps {
  adapter: RemoteRuntimeAdapter;
  panel: ToolPanel;
  /** The Pane's tabs, to find its Diff tab. */
  panels: readonly ToolPanel[];
  connected: boolean;
  /** Opens a Session worker's Pane in this client. */
  onOpenWorker: (paneId: string, orchestrationSessionId: string) => void;
  onSelectPanel: (panelId: string) => void;
}

/**
 * The PWA's chat tab. The Session orchestrator's chat is quiet and lists its workers
 * from the host's Session overview, each opening its Pane (D-18, D-19). View diff brings
 * the Pane's Diff tab forward, which shows the branch's changes read-only, as the phone does.
 */
export function RemoteChatTab({ adapter, panel, panels, connected, onOpenWorker, onSelectPanel }: RemoteChatTabProps) {
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const sessionId = (panel.state.customState as ChatPanelState | undefined)?.orchestrationSessionId;
  const workers = useSessionWorkers(adapter.sessionWorkers, sessionId);
  const diffPanelId = panels.find(candidate => candidate.type === 'diff')?.id;
  const actions = useMemo<ChatTurnActions>(() => ({
    onOpenWorker: sessionId ? paneId => onOpenWorker(paneId, sessionId) : undefined,
    onViewDiff: diffPanelId ? () => onSelectPanel(diffPanelId) : undefined,
  }), [diffPanelId, onOpenWorker, onSelectPanel, sessionId]);
  return <ChatTabPanel key={panel.id} panelId={panel.id} client={adapter.chatTab} connected={connected}
    quiet={isSessionChat(panel)} workers={workers} actions={actions}
    placeholder={sessionId ? 'Message the Session…' : undefined} />;
}
