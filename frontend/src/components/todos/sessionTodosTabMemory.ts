import { create } from 'zustand';
import { todoKey } from '../../../../shared/todoKey';
import { shownHostId, useConfigStore } from '../../stores/configStore';
import type { SessionFolds } from './sessionTodosList';

/** A Session's To-dos tab's remembered view (T-23), kept apart so the sidebar's To-dos (T-37) can open a to-do in it. */

type TabView =
  | { kind: 'list' }
  | { kind: 'todo'; machineId: string; number: number }
  | { kind: 'approval'; id: string };

/**
 * What the tab shows and where its selection is, per Session on its machine (`tabMemoryKey`): the tab's content
 * unmounts while another tab shows. Two machines can each have a Session with the same id (T-51 F-4).
 */
export interface TabMemory {
  view: TabView;
  selected: string | null;
  folds: SessionFolds;
}

export const FRESH: TabMemory = { view: { kind: 'list' }, selected: null, folds: {} };

interface TabMemoryState {
  /** By `tabMemoryKey`. */
  tabs: Readonly<Record<string, TabMemory>>;
  update: (tabKey: string, patch: Partial<TabMemory>) => void;
}

/** A Session's To-dos tab, by the machine its to-dos are on (a `sessionTodoMachine` id) and its id. */
export function tabMemoryKey(machineId: string, sessionId: string): string {
  return `${machineId}:${sessionId}`;
}

export const useTabMemory = create<TabMemoryState>((set) => ({
  tabs: {},
  update: (tabKey, patch) => set(state => ({ tabs: { ...state.tabs, [tabKey]: { ...(state.tabs[tabKey] ?? FRESH), ...patch } } })),
}));

/**
 * Opens to-do `number` in a Session's To-dos tab, as a click on its row there would (T-37: the sidebar's To-dos).
 * The Session and the to-do are on `machineId`, by default the computer the window shows.
 */
export function showSessionTodo(sessionId: string, number: number, machineId: string = shownHostId(useConfigStore.getState().config)): void {
  useTabMemory.getState().update(tabMemoryKey(machineId, sessionId), { view: { kind: 'todo', machineId, number }, selected: todoKey(machineId, number) });
}
