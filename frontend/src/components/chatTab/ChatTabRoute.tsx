import { lazy, useMemo } from 'react';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { useActiveMachineStore } from '../../stores/activeMachineStore';
import { openFileInEditor } from '../../services/openFileInEditor';
import { showActionError } from '../../stores/errorStore';
import { API } from '../../utils/api';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionWorkers, type SessionWorkerSource } from './sessionWorkers';
import { savedFilePath } from './chatAttachments';
import type { ChatTurnActions } from './ChatTurns';
import { onSessionOverviewChange } from '../../utils/sessionOverviewEvents';

/** The desktop reads the Session overview over IPC and hears its updates as window events. */
const DESKTOP_WORKERS: SessionWorkerSource = {
  overview: sessionId => API.orchestrationSessions.overview({ sessionId }).then(response => response.success ? response.data : undefined),
  onChange: callback => onSessionOverviewChange(callback),
};

const ChatTabPanel = lazy(() => import('./ChatTabPanel'));

/** A path the agent reported, relative to the tab's worktree when it is inside it. */
function worktreeRelative(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  const root = cwd.replace(/[\\/]+$/, '');
  return file.startsWith(`${root}/`) || file.startsWith(`${root}\\`) ? file.slice(root.length + 1) : file;
}

/** The desktop's chat tab: the Session orchestrator's chat lists its workers (D-18). */
export function ChatTabRoute({ panel }: { panel: ToolPanel }) {
  const machine = useActiveMachineStore(state => state.machine);
  const setActiveSession = useSessionStore(store => store.setActiveSession);
  const navigateToSessions = useNavigationStore(store => store.navigateToSessions);
  // The Pane's pull request, for the chat's status bar; each field selected alone so other git changes do not re-render the chat.
  const prNumber = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prNumber);
  const prUrl = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prUrl);
  const prState = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prState);
  const prDraft = useSessionStore(store => store.sessions.find(session => session.id === panel.sessionId)?.gitStatus?.prIsDraft);
  const pr = useMemo(() => prNumber ? { number: prNumber, url: prUrl, state: prState, draft: prDraft } : undefined, [prNumber, prUrl, prState, prDraft]);
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  const workers = useSessionWorkers(DESKTOP_WORKERS, state?.orchestrationSessionId);
  // Dropped and pasted files land in the Pane's folder on its machine, local or remote, as the terminal's do.
  const saveFile = useMemo(() => async (file: { name: string; dataUrl: string }) =>
    savedFilePath(await window.electronAPI.invoke('terminal:paste-file', panel.sessionId, file.dataUrl, file.name, { keepName: true })), [panel.sessionId]);
  // Stable, so a re-render here does not re-render every turn of the chat.
  const cwd = state?.cwd;
  const actions = useMemo<ChatTurnActions>(() => ({
    onOpenWorker: paneId => { setActiveSession(paneId); navigateToSessions(); },
    onViewDiff: file => void openFileInEditor({ sessionId: panel.sessionId, filePath: worktreeRelative(file, cwd), pin: true, diff: { kind: 'scope', scope: { kind: 'session' } } })
      .catch(error => showActionError('Could not open the diff', error)),
  }), [cwd, navigateToSessions, panel.sessionId, setActiveSession]);
  return <ChatTabPanel
    saveFile={saveFile}
    workers={workers}
    panelId={panel.id}
    client={window.electronAPI.chatTab}
    machine={machine}
    placeholder={state?.orchestrationSessionId ? 'Ask the Session anything' : undefined}
    actions={actions}
    pr={pr}
  />;
}
