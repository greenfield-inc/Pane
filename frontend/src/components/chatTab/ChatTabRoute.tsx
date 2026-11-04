import { lazy, useEffect, useState } from 'react';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { useActiveMachineStore } from '../../stores/activeMachineStore';
import { openFileInEditor } from '../../services/openFileInEditor';
import { showActionError } from '../../stores/errorStore';
import { isSessionChat } from './sessionChat';
import { API } from '../../utils/api';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { workerLines, type ChatWorkerLine } from '../../../../shared/chatTabPresentation';

/** The Session's workers from Pane's own overview, kept current as their states and reports change. */
function useSessionWorkers(sessionId: string | undefined): ChatWorkerLine[] | undefined {
  const [workers, setWorkers] = useState<ChatWorkerLine[]>();
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void API.orchestrationSessions.overview({ sessionId }).then(response => {
        if (!live || !response.success || !response.data) return;
        const attached = new Map(response.data.session.associations.map(association => [association.paneId, association.attachedAt]));
        setWorkers(workerLines(response.data.panes, attached));
      }).catch(() => undefined);
    };
    // Status changes arrive in bursts; one read covers each burst.
    const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 300); };
    refresh();
    window.addEventListener('orchestration-sessions-overview-updated', soon);
    window.addEventListener('orchestration-sessions-changed', soon);
    return () => { live = false; if (timer) clearTimeout(timer); window.removeEventListener('orchestration-sessions-overview-updated', soon); window.removeEventListener('orchestration-sessions-changed', soon); };
  }, [sessionId]);
  return workers;
}

const ChatTabPanel = lazy(() => import('./ChatTabPanel'));

/** A path the agent reported, relative to the tab's worktree when it is inside it. */
function worktreeRelative(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  const root = cwd.replace(/[\\/]+$/, '');
  return file.startsWith(`${root}/`) || file.startsWith(`${root}\\`) ? file.slice(root.length + 1) : file;
}

/** The desktop's chat tab: the Session orchestrator's chat is quiet (D-18). */
export function ChatTabRoute({ panel }: { panel: ToolPanel }) {
  const machine = useActiveMachineStore(state => state.machine);
  const setActiveSession = useSessionStore(store => store.setActiveSession);
  const navigateToSessions = useNavigationStore(store => store.navigateToSessions);
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  const workers = useSessionWorkers(state?.orchestrationSessionId);
  return <ChatTabPanel
    workers={workers}
    panelId={panel.id}
    client={window.electronAPI.chatTab}
    machine={machine}
    quiet={isSessionChat(panel)}
    placeholder={state?.orchestrationSessionId ? 'Message the Session…' : undefined}
    actions={{
      onOpenWorker: paneId => { setActiveSession(paneId); navigateToSessions(); },
      onViewDiff: file => void openFileInEditor({ sessionId: panel.sessionId, filePath: worktreeRelative(file, state?.cwd), pin: true, diff: { kind: 'scope', scope: { kind: 'session' } } })
        .catch(error => showActionError('Could not open the diff', error)),
    }}
  />;
}
