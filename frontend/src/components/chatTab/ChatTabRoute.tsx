import { lazy } from 'react';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { useActiveMachineStore } from '../../stores/activeMachineStore';
import { openFileInEditor } from '../../services/openFileInEditor';
import { showActionError } from '../../stores/errorStore';

const ChatTabPanel = lazy(() => import('./ChatTabPanel'));

/** A path the agent reported, relative to the tab's worktree when it is inside it. */
export function worktreeRelative(file: string, cwd: string | undefined): string {
  if (!cwd) return file;
  const root = cwd.replace(/[\\/]+$/, '');
  return file.startsWith(`${root}/`) || file.startsWith(`${root}\\`) ? file.slice(root.length + 1) : file;
}

/** The desktop's chat tab: the Session orchestrator's chat is quiet (D-18). */
export function ChatTabRoute({ panel }: { panel: ToolPanel }) {
  const machine = useActiveMachineStore(state => state.machine);
  // SAFETY: the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  return <ChatTabPanel
    panelId={panel.id}
    client={window.electronAPI.chatTab}
    machine={machine}
    quiet={!!state?.orchestrationSessionId}
    placeholder={state?.orchestrationSessionId ? 'Message the Session…' : undefined}
    actions={{
      onViewDiff: file => void openFileInEditor({ sessionId: panel.sessionId, filePath: worktreeRelative(file, state?.cwd), pin: true, diff: { kind: 'scope', scope: { kind: 'session' } } })
        .catch(error => showActionError('Could not open the diff', error)),
    }}
  />;
}
