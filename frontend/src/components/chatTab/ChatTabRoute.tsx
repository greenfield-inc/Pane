import { usePanelStore } from '../../stores/panelStore';
import { openPaneTarget } from '../terminal/openPaneLink';
import { devicePhaseOf, devicesOpenedBy } from '../../../../shared/deviceMarker';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { useActiveMachineStore } from '../../stores/activeMachineStore';
import { openFileInEditor } from '../../services/openFileInEditor';
import { showActionError } from '../../stores/errorStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSessionWorkers } from './sessionWorkers';
import { DESKTOP_WORKERS, openWorkerTab } from './desktopSessionWorkers';
import type { SaveChatFile } from './chatAttachments';
import { uploadFileToHost } from '../../utils/hostUpload';
import type { ChatTurnActions } from './ChatTurns';
import { SessionApprovalCards } from '../approvals/SessionApprovalCards';
import { referencedFile } from './chatReferences';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import ChatTabPanel from './ChatTabPanel';
import type { ChatRendering } from './chatRendering';

/** A path the agent reported, relative to the tab's worktree when it is inside it. */
function worktreeRelative(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  const root = cwd.replace(/[\\/]+$/, '');
  return file.startsWith(`${root}/`) || file.startsWith(`${root}\\`) ? file.slice(root.length + 1) : file;
}

/** The desktop's chat tab: the Session orchestrator's chat lists its workers (D-18). */
export function ChatTabRoute({ panel }: { panel: ToolPanel }) {
  const machine = useActiveMachineStore(state => state.machine);
  // The Pane's pull request, for the chat's status bar; each field selected alone so other git changes do not re-render the chat.
  const prNumber = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prNumber);
  const prUrl = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prUrl);
  const prState = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prState);
  const prDraft = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prIsDraft);
  const pr = useMemo(() => prNumber ? { number: prNumber, url: prUrl, state: prState, draft: prDraft } : undefined, [prNumber, prUrl, prState, prDraft]);
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  const workers = useSessionWorkers(DESKTOP_WORKERS, state?.orchestrationSessionId);
  const sessionId = state?.orchestrationSessionId;
  // Dropped and pasted files land in the Pane's folder on its machine, local or remote, as the terminal's do.
  const saveFile = useMemo<SaveChatFile>(() => (file, onProgress, signal) => uploadFileToHost({
    invoke: (channel, args) => window.electronAPI.invoke(channel, ...args), file, sessionId: panel.sessionId, keepName: true, onProgress, signal,
  }), [panel.sessionId]);
  // Stable, so a re-render here does not re-render every turn of the chat.
  const cwd = state?.cwd;
  // The Pane's device tabs, so device cards follow their device's state; other tabs' changes keep `actions` as it is.
  const deviceTabs = usePanelStore(useShallow(store => (store.panels[panel.sessionId] ?? []).filter(tab => tab.type === 'device')));
  const root = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.worktreePath);
  const actions = useMemo<ChatTurnActions>(() => ({
    onOpenWorker: (paneId: string, panelId?: string) => { void openWorkerTab(paneId, panelId); },
    onViewDiff: file => void openFileInEditor({ sessionId: panel.sessionId, filePath: worktreeRelative(file, cwd), pin: true, diff: { kind: 'scope', scope: { kind: 'session' } } })
      .catch(error => showActionError('Could not open the diff', error)),
    onOpenFile: async file => {
      const filePath = referencedFile(file, cwd, root);
      if (!filePath || await window.electronAPI.invoke('file:exists', { sessionId: panel.sessionId, filePath }) !== true) return false;
      await openFileInEditor({ sessionId: panel.sessionId, filePath, pin: true });
      return true;
    },
    device: {
      openedHere: devicesOpenedBy(deviceTabs, panel.id),
      phase: panelId => devicePhaseOf(deviceTabs, panelId),
      frame: async panelId => {
        const response = await window.electronAPI.devices.frame(panelId);
        return response.success ? response.data : undefined;
      },
      open: panelId => { void openPaneTarget({ paneId: panel.sessionId, panelId }); },
    },
  }), [cwd, root, panel.id, panel.sessionId, deviceTabs]);
  // Links in the chat open beside it, in this Pane (Settings > Links).
  const rendering = useMemo<ChatRendering>(() => ({ paneId: panel.sessionId }), [panel.sessionId]);
  return <ChatTabPanel
    rendering={rendering}
    saveFile={saveFile}
    workers={workers}
    panelId={panel.id}
    client={window.electronAPI.chatTab}
    machine={machine}
    session={!!state?.orchestrationSessionId}
    actions={actions}
    // A Session's orchestrator chat shows its approvals as light cards above the composer (P5).
    dock={state?.orchestrationSessionId ? <SessionApprovalCards sessionId={state.orchestrationSessionId} chatPanelId={panel.id} /> : undefined}
    onReloadProfile={sessionId ? async () => { await useOrchestrationSessionStore.getState().reloadProfile(sessionId); } : undefined}
    pr={pr}
  />;
}
