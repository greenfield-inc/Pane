import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { TodoAction, TodoActionResult, TodoCreateInput, TodoDetail, TodoRecord, TodosSnapshot } from '../../../shared/types/todos';
import { LOCAL_MACHINE_ID, type MachineCommand, type MachineConnectionsEvent, type MachineEventChannel, type MachineState } from '../../../shared/types/machineConnections';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { showActionError } from './errorStore';

interface RemoteTodoAnswer {
  success: boolean;
  error?: string;
  data?: RemoteAnswerData;
}

interface RemoteAnswerData {
  number?: number;
}

/** What another machine's `todos:act` or `todos:create` answered, as far as the screen needs it. */
const remoteAnswerSchema: BoundarySchema<RemoteTodoAnswer> = boundary.object({
  success: boundary.boolean,
  error: boundary.optional(boundary.string),
  data: boundary.optional(boundary.object({ number: boundary.optional(boundary.number) })),
});

/** A to-do made on another machine: which machine, and its number there. */
export interface CreatedTodo {
  machineId: string;
  number: number;
}

/** Another saved machine's to-dos, as the To-dos screen merges them in (J46). */
export interface RemoteTodos {
  machineId: string;
  label: string;
  /** The last list read; kept while the machine is offline so its rows stay, read as offline. */
  snapshot: TodosSnapshot | null;
  offline: boolean;
}

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
  /** Saved machines' to-dos, by machine id. */
  remote: Readonly<Record<string, RemoteTodos>>;
  /** Saved machines as `machines.list` last said, so a reread knows their names and whether they answer. */
  machines: readonly MachineState[];
  setMachines: (machines: readonly MachineState[]) => void;
  /** Rereads one saved machine's to-dos, or every online one. */
  refreshRemote: (machineId?: string) => Promise<void>;
  /** Runs one action on a saved machine's to-do; false after showing why it failed. */
  actOn: (machineId: string, action: TodoAction) => Promise<boolean>;
  /** Creates a to-do (and its Session) on a saved machine; null after showing why it failed. */
  createOn: (machineId: string, input: TodoCreateInput) => Promise<CreatedTodo | null>;
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

  remote: {},
  machines: [],
  setMachines: (machines) => {
    const saved = machines.filter(machine => machine.kind === 'remote' && machine.id !== LOCAL_MACHINE_ID);
    set(state => {
      const remote: Record<string, RemoteTodos> = {};
      for (const machine of saved) {
        const known = state.remote[machine.id];
        remote[machine.id] = { machineId: machine.id, label: machine.label, snapshot: known?.snapshot ?? null, offline: machine.status === 'offline' };
      }
      return { machines: saved, remote };
    });
  },
  refreshRemote: async (machineId) => {
    const api = window.electronAPI?.machines;
    if (!api) return;
    const targets = get().machines.filter(machine => (machineId === undefined || machine.id === machineId) && machine.status === 'online');
    await Promise.all(targets.map(async machine => {
      const response = await api.read(machine.id, 'todos:snapshot').then(read => read.data, () => null);
      // A machine whose Pane predates To-dos answers with an error: it has none.
      const snapshot = response?.success && response.data ? response.data : null;
      set(state => {
        const known = state.remote[machine.id];
        if (!known) return {};
        return { remote: { ...state.remote, [machine.id]: { ...known, snapshot: snapshot ?? (response ? null : known.snapshot), offline: false } } };
      });
    }));
  },

  actOn: async (machineId, action) => {
    const answer = await runOnMachine(machineId, { type: 'todo-act', action }, 'That didn’t work');
    if (!answer) return false;
    await get().refreshRemote(machineId);
    return true;
  },

  createOn: async (machineId, input) => {
    const answer = await runOnMachine(machineId, { type: 'todo-create', input }, 'Could not create the to-do');
    const number = answer?.data?.number;
    if (number === undefined) return null;
    await get().refreshRemote(machineId);
    return { machineId, number };
  },
}));


/** One to-do command on another machine, through that machine's own checks; null after showing why it failed. */
async function runOnMachine(machineId: string, command: MachineCommand, failure: string): Promise<RemoteTodoAnswer | null> {
  try {
    const result = await window.electronAPI.machines.run(machineId, command);
    const answer: RemoteTodoAnswer | undefined = decodeOptionalBoundary(result.data, remoteAnswerSchema);
    if (!answer?.success) {
      showActionError(failure, answer?.error ?? 'The machine did not answer. Check that it is online, then try again.');
      return null;
    }
    return answer;
  } catch (error) {
    showActionError(failure, error);
    return null;
  }
}

/** Events from another machine after which its to-dos may read differently. */
const REMOTE_TODO_EVENTS: ReadonlySet<MachineEventChannel> = new Set<MachineEventChannel>([
  'orchestration-sessions:changed',
  'orchestration-sessions:activity',
  'notify:shared-changed',
]);
const REMOTE_REREAD_DEBOUNCE_MS = 500;

/**
 * Keeps saved machines' to-dos current while the sidebar is mounted: read when a machine is first
 * seen or reconnects, and again after its Sessions or approvals change.
 */
export function useTodosMachines(): void {
  useEffect(() => {
    const api = window.electronAPI?.machines;
    if (!api) return;
    let stopped = false;
    const timers = new Map<string, number>();
    const schedule = (machineId: string) => {
      const pending = timers.get(machineId);
      if (pending !== undefined) window.clearTimeout(pending);
      timers.set(machineId, window.setTimeout(() => {
        timers.delete(machineId);
        if (!stopped) void useTodosStore.getState().refreshRemote(machineId);
      }, REMOTE_REREAD_DEBOUNCE_MS));
    };
    const applyMachines = (machines: readonly MachineState[]) => {
      const before = new Map(useTodosStore.getState().machines.map(machine => [machine.id, machine.status]));
      useTodosStore.getState().setMachines(machines);
      for (const machine of machines) {
        if (machine.kind === 'remote' && machine.status === 'online' && before.get(machine.id) !== 'online') schedule(machine.id);
      }
    };
    const onEvent = (event: MachineConnectionsEvent) => {
      if (event.type === 'machines') applyMachines(event.machines);
      else if (event.type === 'resync') schedule(event.machineId);
      else if (REMOTE_TODO_EVENTS.has(event.channel)) schedule(event.machineId);
    };
    const unsubscribe = api.onEvent(onEvent);
    api.list().then(machines => { if (!stopped) applyMachines(machines); }).catch(() => undefined);
    return () => {
      stopped = true;
      unsubscribe();
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);
}

const REMOTE_POLL_MS = 15_000;

/** While the To-dos screen is open, saved machines' to-dos are reread every 15 s: a status can change without an event. */
export function useRemoteTodosPoll(): void {
  useEffect(() => {
    const timer = window.setInterval(() => { void useTodosStore.getState().refreshRemote(); }, REMOTE_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
}

/** The to-do page's data, kept current while it is on screen. */
export function useTodoDetail(number: number | null): TodoDetail | null {
  const detail = useTodosStore(state => (number === null ? null : state.details.get(number) ?? null));
  const watch = useTodosStore(state => state.watch);
  useEffect(() => (number === null ? undefined : watch(number)), [number, watch]);
  return detail;
}

/** This machine's to-dos' own Sessions, kept out of the Sessions sidebar, All machines and Mod+1–9 (D-409). */
export function useTodoSessionIds(): ReadonlySet<string> {
  const ids = useTodosStore(state => state.snapshot?.ownSessionIds);
  return useMemo(() => new Set(ids ?? []), [ids]);
}

/** Every machine's to-dos' own Sessions, as `<machine id>:<Session id>`, for All machines. */
export function useMachineTodoSessionKeys(): ReadonlySet<string> {
  const local = useTodosStore(state => state.snapshot?.ownSessionIds);
  const remote = useTodosStore(state => state.remote);
  return useMemo(() => new Set([
    ...(local ?? []).map(id => `${LOCAL_MACHINE_ID}:${id}`),
    ...Object.values(remote).flatMap(machine => (machine.snapshot?.ownSessionIds ?? []).map(id => `${machine.machineId}:${id}`)),
  ]), [local, remote]);
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
