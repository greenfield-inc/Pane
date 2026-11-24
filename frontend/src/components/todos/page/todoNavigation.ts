import type { TodoDetail } from '../../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { useNavigationStore } from '../../../stores/navigationStore';
import { usePanelStore } from '../../../stores/panelStore';
import { useOrchestrationSessionStore } from '../../../stores/orchestrationSessionStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { openOnMachine } from '../../../utils/machineRowActions';

/** The machine a to-do runs on, as machine actions name it. */
function machineOf(detail: TodoDetail): string {
  return detail.machineId ?? LOCAL_MACHINE_ID;
}

/**
 * Session · Open: the to-do's own Session (hidden from the sidebar), or its parent's for a sub-to-do.
 * The Session's breadcrumb then returns to this to-do, a sub-to-do included (round 8, T-4).
 */
export function openTodoSession(detail: TodoDetail): void {
  const sessionId = detail.todo.sessionId ?? detail.parent?.todo.sessionId;
  if (!sessionId) return;
  useNavigationStore.getState().setTodoSessionOrigin({ machineId: machineOf(detail), sessionId, number: detail.todo.number });
  void openOnMachine(machineOf(detail), { kind: 'session', id: sessionId, name: detail.sessionName ?? detail.todo.ref });
}

/**
 * Brings a tab of the to-do's work forward: its Session's orchestrator tab, or a worker's tab in its
 * own Pane. A chat tab can't yet scroll to one turn, so "Open in the Session chat" focuses the tab
 * the reply was written in and leaves it at its latest turn.
 */
export function focusTodoTab(detail: TodoDetail, panelId: string): void {
  const panels = usePanelStore.getState().panels;
  const loadedIn = Object.keys(panels).find((paneId) => panels[paneId]?.some((panel) => panel.id === panelId));
  const assigneePane = detail.todo.assignee?.panelId === panelId ? detail.todo.assignee.paneId : undefined;
  const paneId = loadedIn ?? assigneePane;
  const sessionId = detail.todo.sessionId ?? detail.parent?.todo.sessionId;
  const session = sessionId ? useOrchestrationSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId) : undefined;
  const machine = machineOf(detail);
  if (session && (!paneId || paneId === session.internalSessionId)) {
    usePanelStore.getState().requestActivation({ sessionId: session.internalSessionId, panelId });
    useNavigationStore.getState().setTodoSessionOrigin({ machineId: machine, sessionId: session.id, number: detail.todo.number });
    void openOnMachine(machine, { kind: 'session', id: session.id, name: detail.sessionName ?? session.name });
    return;
  }
  if (paneId) {
    usePanelStore.getState().requestActivation({ sessionId: paneId, panelId });
    const name = useSessionStore.getState().sessions.find((candidate) => candidate.id === paneId)?.name ?? detail.todo.assignee?.name ?? detail.todo.ref;
    void openOnMachine(machine, { kind: 'pane', id: paneId, name });
    return;
  }
  openTodoSession(detail);
}

/** The name of a worker's Pane, for "implementer · keyboard-approvals". */
export function paneName(paneId: string | undefined): string | undefined {
  if (!paneId) return undefined;
  return useSessionStore.getState().sessions.find((candidate) => candidate.id === paneId)?.name;
}
