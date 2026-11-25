import { useMemo } from 'react';
import { useNavigationStore } from '../../stores/navigationStore';
import { shownSnapshot, useShownHostId, useTodosStore } from '../../stores/todosStore';
import { mergeTodoEntries, navSummary, type TodoEntry, type TodosNavSummary } from './todoList';

/** Every top-level to-do on this machine and each saved one, newest change first. */
export function useTodoEntries(): TodoEntry[] {
  // The shown computer's own list only once it is read from that computer (T-51 F-1): just after a switch the
  // store can still hold the old one's, whose rows would read and open as this one's.
  const shownHost = useShownHostId();
  const snapshot = useTodosStore(state => shownSnapshot(state, shownHost));
  const remote = useTodosStore(state => state.remote);
  return useMemo(() => mergeTodoEntries(snapshot, Object.values(remote)), [snapshot, remote]);
}

export interface TodosNav extends TodosNavSummary {
  open: boolean;
  /** Read aloud and shown as the tooltip. */
  label: string;
}

/** What the sidebar's To-dos entry shows: the amber count of to-dos waiting on you and the Working spinner. */
export function useTodosNav(): TodosNav {
  const entries = useTodoEntries();
  const open = useNavigationStore(state => state.activeView === 'todos');
  const summary = useMemo(() => navSummary(entries), [entries]);
  const parts = [
    summary.waiting > 0 ? `${summary.waiting} waiting on you` : '',
    summary.working ? 'a to-do is being worked on' : '',
  ].filter(Boolean);
  return { ...summary, open, label: parts.length ? `To-dos, ${parts.join(', ')}` : 'To-dos' };
}
