import { useEffect } from 'react';
import { create } from 'zustand';
import type { TodoAction, TodoActionResult, TodoCreateInput, TodoDetail, TodoRecord, TodosSnapshot } from '../../../shared/types/todos';
import { showActionError } from './errorStore';

/**
 * To-dos (D-409): this machine's snapshot, kept current from `todos:changed`, and each open to-do's
 * page. Main works out every status; the renderer only shows it.
 */
interface TodosState {
  snapshot: TodosSnapshot | null;
  /** Pages read so far, by to-do number; reread on every change. */
  details: ReadonlyMap<number, TodoDetail>;
  /** To-do pages on screen, so a change rereads only those. */
  watched: ReadonlyMap<number, number>;
  refresh: () => Promise<void>;
  loadDetail: (number: number) => Promise<TodoDetail | null>;
  watch: (number: number) => () => void;
  /** Creates and returns the to-do, or null after showing why it failed. */
  create: (input: TodoCreateInput) => Promise<TodoRecord | null>;
  /** Runs one action and returns its result, or null after showing why it failed. */
  act: (action: TodoAction) => Promise<TodoActionResult | null>;
}

let refreshGeneration = 0;

export const useTodosStore = create<TodosState>((set, get) => ({
  snapshot: null,
  details: new Map(),
  watched: new Map(),

  refresh: async () => {
    if (!window.electronAPI?.todos) return;
    const generation = ++refreshGeneration;
    const response = await window.electronAPI.todos.snapshot().catch(() => null);
    if (generation !== refreshGeneration || !response?.success || !response.data) return;
    set({ snapshot: response.data });
    await Promise.all([...get().watched.keys()].map(number => get().loadDetail(number)));
  },

  loadDetail: async (number) => {
    if (!window.electronAPI?.todos) return null;
    const response = await window.electronAPI.todos.detail(number).catch(() => null);
    if (!response?.success || !response.data) return null;
    const detail = response.data;
    set(state => ({ details: new Map(state.details).set(number, detail) }));
    return detail;
  },

  watch: (number) => {
    set(state => ({ watched: new Map(state.watched).set(number, (state.watched.get(number) ?? 0) + 1) }));
    void get().loadDetail(number);
    return () => set(state => {
      const watched = new Map(state.watched);
      const count = (watched.get(number) ?? 1) - 1;
      if (count <= 0) watched.delete(number);
      else watched.set(number, count);
      return { watched };
    });
  },

  create: async (input) => {
    try {
      const response = await window.electronAPI.todos.create(input);
      if (!response.success || !response.data) {
        showActionError('Could not create the to-do', response.error);
        return null;
      }
      await get().refresh();
      return response.data;
    } catch (error) {
      showActionError('Could not create the to-do', error);
      return null;
    }
  },

  act: async (action) => {
    try {
      const response = await window.electronAPI.todos.act(action);
      if (!response.success || !response.data) {
        showActionError('That didn’t work', response.error);
        return null;
      }
      await get().refresh();
      return response.data;
    } catch (error) {
      showActionError('That didn’t work', error);
      return null;
    }
  },
}));

/** The to-do page's data, kept current while it is on screen. */
export function useTodoDetail(number: number | null): TodoDetail | null {
  const detail = useTodosStore(state => (number === null ? null : state.details.get(number) ?? null));
  const watch = useTodosStore(state => state.watch);
  useEffect(() => (number === null ? undefined : watch(number)), [number, watch]);
  return detail;
}

/** Keeps the snapshot current while the app is mounted: on start and whenever main says it changed. */
export function useTodosRefresh(): void {
  const refresh = useTodosStore(state => state.refresh);
  useEffect(() => {
    if (!window.electronAPI?.todos) return;
    void refresh();
    const unsubscribe = window.electronAPI.events.onTodosChanged(() => { void refresh(); });
    return unsubscribe;
  }, [refresh]);
}
