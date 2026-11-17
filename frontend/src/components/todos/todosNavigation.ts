import { useNavigationStore } from '../../stores/navigationStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { useSessionStore } from '../../stores/sessionStore';

/**
 * To-dos there and back (D-409), like Approvals: the sidebar entry opens To-dos, and the same
 * entry, or Esc on the list, returns to the view, Pane and Session you left.
 */

let returnSessionId: string | undefined;

/** Opens To-dos: the list, or to-do `number`'s page. */
export function openTodos(number: number | null = null): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'todos') returnSessionId = useOrchestrationSessionStore.getState().selectedSessionId;
  navigation.navigateToTodos({ number, returnPaneId: useSessionStore.getState().activeSessionId });
}

/** Opens one to-do's page, from search, Approvals or a link. */
export function openTodo(number: number): void {
  openTodos(number);
}

/** Leaves To-dos for where you were. */
export function leaveTodos(): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'todos') return;
  const sessionId = returnSessionId;
  returnSessionId = undefined;
  const back = navigation.leaveTodos();
  const sessions = useSessionStore.getState();
  if (back.paneId !== sessions.activeSessionId) void sessions.setActiveSession(back.paneId);
  if (back.view === 'pane-chat' && sessionId && useOrchestrationSessionStore.getState().selectedSessionId !== sessionId) {
    void useOrchestrationSessionStore.getState().select({ sessionId }).catch(() => undefined);
  }
}

/** The sidebar entry: opens the list, or, while To-dos is open, returns to where you were. */
export function toggleTodos(): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'todos') {
    openTodos(null);
    return;
  }
  // On a to-do's page the entry goes back to the list first, as the breadcrumb does.
  if (navigation.selectedTodoNumber !== null) {
    navigation.selectTodo(null);
    return;
  }
  leaveTodos();
}

/** Typing in a field or a terminal keeps its own keys. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
    || target.closest('.xterm') !== null;
}

/** A menu, list box or dialog is open and takes its own keys first. */
export function overlayOpen(): boolean {
  return document.querySelector('[role="menu"], [role="listbox"], [aria-modal="true"], [data-todos-confirm]') !== null;
}
