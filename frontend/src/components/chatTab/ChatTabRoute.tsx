import { lazy, useMemo } from 'react';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { useActiveMachineStore } from '../../stores/activeMachineStore';
import { openFileInEditor } from '../../services/openFileInEditor';
import { showActionError } from '../../stores/errorStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSessionWorkers } from './sessionWorkers';
import { DESKTOP_WORKERS, openWorkerTab } from './desktopSessionWorkers';
import { savedFilePath } from './chatAttachments';
import type { ChatTurnActions } from './ChatTurns';
import { SessionApprovalCards } from '../approvals/SessionApprovalCards';


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
    onOpenWorker: (paneId: string, panelId?: string) => { void openWorkerTab(paneId, panelId); },
    onViewDiff: file => void openFileInEditor({ sessionId: panel.sessionId, filePath: worktreeRelative(file, cwd), pin: true, diff: { kind: 'scope', scope: { kind: 'session' } } })
      .catch(error => showActionError('Could not open the diff', error)),
  }), [cwd, panel.sessionId]);
  return <ChatTabPanel
    saveFile={saveFile}
    workers={workers}
    panelId={panel.id}
    client={window.electronAPI.chatTab}
    machine={machine}
    placeholder={state?.orchestrationSessionId ? 'Ask the Session anything' : undefined}
    actions={actions}
    // A Session's orchestrator chat shows its approvals as light cards above the composer (P5).
    dock={state?.orchestrationSessionId ? <SessionApprovalCards sessionId={state.orchestrationSessionId} /> : undefined}
    pr={pr}
  />;
}
