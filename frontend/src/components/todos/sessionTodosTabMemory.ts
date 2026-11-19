import { create } from 'zustand';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import type { SessionFolds } from './sessionTodosList';

/** A Session's To-dos tab's remembered view (T-23), kept apart so the sidebar's To-dos (T-37) can open a to-do in it. */

type TabView =
  | { kind: 'list' }
  | { kind: 'todo'; number: number }
  | { kind: 'approval'; id: string };

/** What the tab shows and where its selection is, per Session: the tab's content unmounts while another tab shows. */
export interface TabMemory {
  view: TabView;
  selected: string | null;
  folds: SessionFolds;
}

export const FRESH: TabMemory = { view: { kind: 'list' }, selected: null, folds: {} };

interface TabMemoryState {
  tabs: Readonly<Record<string, TabMemory>>;
  update: (sessionId: string, patch: Partial<TabMemory>) => void;
}

export const useTabMemory = create<TabMemoryState>((set) => ({
  tabs: {},
  update: (sessionId, patch) => set(state => ({ tabs: { ...state.tabs, [sessionId]: { ...(state.tabs[sessionId] ?? FRESH), ...patch } } })),
}));

/** Opens to-do `number` in a Session's To-dos tab, as a click on its row there would (T-37: the sidebar's To-dos). */
export function showSessionTodo(sessionId: string, number: number, machineId: string = LOCAL_MACHINE_ID): void {
  useTabMemory.getState().update(sessionId, { view: { kind: 'todo', number }, selected: `${machineId}:${number}` });
}
