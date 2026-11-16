import { lazy, useEffect, useMemo, useState } from 'react';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import type { ToolPanel } from '../../../../shared/types/panels';
import { useSessionWorkers } from '../../components/chatTab/sessionWorkers';
import type { ChatTurnActions } from '../../components/chatTab/ChatTurns';
import type { ChatDeviceActions } from '../../components/chatTab/DeviceCard';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import type { ChatStatusPullRequest } from '../../components/chatTab/ChatStatusBar';
import { watchPanePullRequest } from './panePullRequest';
import { devicePhaseOf, devicesOpenedBy } from '../../../../shared/deviceMarker';

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
 * The PWA's chat tab. The Session orchestrator's chat lists its workers
 * from the host's Session overview, each opening its Pane (D-18, D-19). View diff brings
 * the Pane's Diff tab forward, which shows the branch's changes read-only, as the phone does.
 */
export function RemoteChatTab({ adapter, panel, panels, connected, onOpenWorker, onSelectPanel }: RemoteChatTabProps) {
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const sessionId = (panel.state.customState as ChatPanelState | undefined)?.orchestrationSessionId;
  const workers = useSessionWorkers(adapter.sessionWorkers, sessionId);
  // The Pane's pull request for the status bar's PR item, from the host's git status (review F-3).
  const [pr, setPr] = useState<ChatStatusPullRequest>();
  useEffect(() => watchPanePullRequest(adapter, panel.sessionId, setPr), [adapter, panel.sessionId]);
  const diffPanelId = panels.find(candidate => candidate.type === 'diff')?.id;
  // The device tabs as text, so `actions` changes only when a device tab does, not with every panel update.
  const deviceTabsKey = JSON.stringify(panels.filter(candidate => candidate.type === 'device').map(tab => [tab.id, tab.state.customState]));
  const device = useMemo<ChatDeviceActions>(() => ({
    openedHere: devicesOpenedBy(panels, panel.id),
    phase: panelId => devicePhaseOf(panels, panelId),
    frame: panelId => adapter.invoke<string>('devices:frame', [panelId]),
    open: onSelectPanel,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deviceTabsKey stands for the device tabs read from panels
  }), [adapter, deviceTabsKey, onSelectPanel, panel.id]);
  const actions = useMemo<ChatTurnActions>(() => ({
    onOpenWorker: sessionId ? paneId => onOpenWorker(paneId, sessionId) : undefined,
    onViewDiff: diffPanelId ? () => onSelectPanel(diffPanelId) : undefined,
    device,
  }), [device, diffPanelId, onOpenWorker, onSelectPanel, sessionId]);
  // Dropped and pasted files land in the Pane's folder on the host, as the terminal's do.
  const saveFile = useMemo(() => (file: { name: string; dataUrl: string }) => adapter.saveFile(panel.sessionId, file), [adapter, panel.sessionId]);
  return <ChatTabPanel key={panel.id} panelId={panel.id} client={adapter.chatTab} connected={connected}
    workers={workers} actions={actions} saveFile={saveFile} pr={pr}
    placeholder={sessionId ? 'Ask the Session anything' : undefined} />;
}
