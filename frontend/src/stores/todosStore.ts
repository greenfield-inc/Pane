import { isReadOnlyHost } from './readOnlyHostStore';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { TodoAction, TodoActionResult, TodoCreateInput, TodoDetail, TodoListRow, TodoRecord, TodosSnapshot } from '../../../shared/types/todos';
import { isMac } from '../utils/platformUtils';
import { LOCAL_MACHINE_ID, type MachineCommand, type MachineConnectionsEvent, type MachineEventChannel, type MachineState } from '../../../shared/types/machineConnections';
import { otherMachines } from '../components/todos/todoList';
import { approvalsByTodo, emptyTodoScope, todoApprovalScope, type TodoApprovalScope } from '../components/todos/sessionTodos';
import { machineOfItem, todoKey, todoRefOn, type TodoKey } from '../../../shared/todoKey';
import { sessionTodoEntries } from '../components/todos/sessionTodosList';
import type { TodoEntry } from '../components/todos/todoList';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { newestFirst } from '../../../shared/approvalOrder';
import { isTodosEnabled, shownHostId, useConfigStore } from './configStore';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { showActionError } from './errorStore';
import { selectNotifyItems, sessionTodoApprovals, useNotifyStore } from './notifyStore';
import { useNavigationStore } from './navigationStore';
import type { NotifyItem, NotifySnapshot } from '../../../shared/types/notify';
import type { AutopilotDocument } from '../../../shared/types/autopilot';

/** What one to-do channel answers: the IPC envelope `todos:*` replies in. */
export interface TodosAnswer<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** A file from this device, as the composer and New to-do save pasted ones. */
interface TodoSavedFile {
  name: string;
  dataUrl: string;
  type: string;
}

/** Picking and saving files on the device the app runs on: the desktop has both, the web app neither. */
interface TodoFilesApi {
  /** 📎: a file picked on this machine, or null when the person cancelled. */
  pick: () => Promise<string | null>;
  /** Pasted or dropped files, saved as files on this machine; their paths. */
  save: (draftId: string, files: TodoSavedFile[]) => Promise<string[]>;
}

/**
 * Where the to-do screens read and act (P7). The desktop's is the preload's `todos` API; the web app
 * (Remote PWA, and the Capacitor shell) installs one over its daemon connection with `installTodosApi`.
 */
export interface TodosApi {
  snapshot: () => Promise<TodosAnswer<TodosSnapshot>>;
  detail: (number: number) => Promise<TodosAnswer<TodoDetail>>;
  create: (input: TodoCreateInput) => Promise<TodosAnswer<TodoRecord>>;
  act: (action: TodoAction) => Promise<TodosAnswer<TodoActionResult>>;
  /** `todos:changed`: something on the host changed its to-dos. Returns the unsubscribe. */
  onChanged: (listener: () => void) => () => void;
  /** An attached file or a description's image, read from the to-do's machine (an HTML page as its text where the app can't load a file URL). */
  readDoc: (path: string) => Promise<AutopilotDocument>;
  /** A web address, outside the app. */
  openUrl: (url: string) => void;
  /** Absent where the app can't pick or save a file (the web app): 📎 then stays out of the composer. */
  files?: TodoFilesApi;
  /** The host is the computer the app runs on: its name then reads "This Mac". */
  hostIsHere: boolean;
}

/** The desktop's to-do API: the preload's, unchanged. Null outside Electron until one is installed. */
function electronTodosApi(): TodosApi | null {
  // To-dos is off by default (T-39): the desktop reads none, and main refuses the channels anyway.
  if (!isTodosEnabled(useConfigStore.getState().config)) return null;
  const api = window.electronAPI;
  if (!api?.todos) return null;
  return {
    snapshot: () => api.todos.snapshot(),
    detail: (number) => api.todos.detail(number),
    create: (input) => api.todos.create(input),
    act: (action) => api.todos.act(action),
    onChanged: (listener) => api.events.onTodosChanged(listener),
    readDoc: (path) => api.autopilot.readDoc(path),
    openUrl: (url) => { void api.openExternal(url); },
    // A read-only computer takes no files, so nothing picks, pastes or drops one.
    files: isReadOnlyHost() ? undefined : {
      pick: async () => {
        const response = await api.dialog.openFile().catch(() => null);
        return response?.success ? response.data ?? null : null;
      },
      save: (draftId, files) => api.sessions.saveImages(draftId, files),
    },
    hostIsHere: true,
  };
}

let installedApi: TodosApi | null = null;

/** The web app's API, installed while it is connected to a host; null puts the desktop's back. */
export function installTodosApi(api: TodosApi | null): void {
  installedApi = api;
}

/** The API the to-do screens use now: the installed one, else the desktop's, else none. */
export function todosApi(): TodosApi | null {
  return installedApi ?? electronTodosApi();
}

/**
 * Whether To-dos shows anywhere (T-39). The desktop follows its own switch (Settings › Advanced ›
 * Experimental › To-dos); the web app shows To-dos once its host answers with them, so a host with
 * To-dos off shows none.
 */
export function useTodosEnabled(): boolean {
  const switchedOn = useConfigStore(state => isTodosEnabled(state.config));
  const hostAnswered = useTodosStore(state => state.snapshot !== null);
  return installedApi ? hostAnswered : switchedOn;
}

/** What `useTodosEnabled` says, read once outside React. */
export function todosEnabledNow(): boolean {
  return installedApi ? useTodosStore.getState().snapshot !== null : isTodosEnabled(useConfigStore.getState().config);
}

/** A host with To-dos off refuses its channels with this (main's TODOS_DISABLED). */
function refusedAsOff(error: string | undefined): boolean {
  return error?.includes('To-dos is turned off') === true;
}

interface RemoteTodoAnswer {
  success: boolean;
  error?: string;
  data?: RemoteAnswerData;
}

interface RemoteAnswerData {
  number?: number;
}

/** `act` and `create` run on the computer this window shows; one it only watches takes neither (a key can still ask). */
function refusedReadOnly(): boolean {
  if (!isReadOnlyHost()) return false;
  showActionError('Read only', 'This computer gives you read-only access, so its to-dos can’t be changed from here. Nothing was changed.');
  return true;
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
  /**
   * The machine `snapshot` was read from (T-51), by the id the window names it with: a list is shown only while
   * that is the computer the window shows, so another machine's rows never read as its own.
   */
  snapshotMachine: string | null;
  /** Each machine's install id, by the window's id for it, as `machines.list` last said: what checks where a read came from. */
  installIds: Readonly<Record<string, string>>;
  /** The host answered that To-dos is turned off (T-39), as opposed to not read yet: open To-dos screens close. */
  hostTodosOff: boolean;
  /**
   * Pages read so far, by machine and number (T-51), each stamped with the machine it was read from;
   * reread on every change.
   */
  details: ReadonlyMap<TodoKey, TodoDetail>;
  /** To-do pages on screen, by machine and number, so a change rereads only the shown computer's. */
  watched: ReadonlyMap<TodoKey, WatchedTodo>;
  refresh: () => Promise<void>;
  /** Reads to-do `number` of the computer this window shows. */
  loadDetail: (number: number) => Promise<TodoDetail | null>;
  /** Keeps to-do `number` of the computer this window shows current; returns the stop. */
  watch: (number: number) => () => void;
  /** Creates and returns the to-do, or null after showing why it failed. */
  create: (input: TodoCreateInput) => Promise<TodoRecord | null>;
  /** Runs one action and returns its result, or null after showing why it failed. */
  act: (action: TodoAction) => Promise<TodoActionResult | null>;
  /**
   * This computer's own to-dos while the window shows another computer (T-51): All machines still lists
   * this computer's Sessions, and their approvals scope reads these. Null while the window shows this one.
   */
  desktop: TodosSnapshot | null;
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
  /**
   * Round 9: a to-do whose page should open its snooze menu (a reminder card's "Snooze to another time…"),
   * by machine (T-51), so another machine's reminder never opens this computer's to-do with that number.
   */
  snoozeRequest: TodoKey | null;
  requestSnooze: (key: TodoKey | null) => void;
}

/** A page on screen: which machine's to-do, and how many views watch it. */
interface WatchedTodo {
  machineId: string;
  number: number;
  count: number;
}

let refreshGeneration = 0;
/** Reads of the list that reached the wrong computer, in a row; each waits STALE_RETRY_MS and reads again. */
let staleRetries = 0;
const STALE_RETRY_MS = 1_000;
const STALE_RETRY_LIMIT = 30;

/**
 * Whether a list read for machine `machine` came from it (T-51 F-1), by the install id the host puts on its
 * list. An older host sends none, and a machine whose install id isn't known yet can't be checked: both pass.
 * This computer's own list never passes as a saved machine's.
 */
function fromMachine(snapshot: TodosSnapshot, machine: string, installIds: Readonly<Record<string, string>>): boolean {
  if (!snapshot.installId) return true;
  const expected = installIds[machine];
  if (expected) return snapshot.installId === expected;
  return machine === LOCAL_MACHINE_ID || snapshot.installId !== installIds[LOCAL_MACHINE_ID];
}
/** Bumped when To-dos turns off (T-51): a saved machine's read still in flight then lands nowhere. */
let remoteGeneration = 0;
/**
 * Each to-do's newest detail read, so an older answer never replaces a newer one. One count for every read,
 * never reset, so a read from before a computer switch can't match one made after it (T-51).
 */
let detailReads = 0;
const detailGenerations = new Map<TodoKey, number>();

/** The computer this window shows now, by the id its to-dos are keyed under. */
function shownNow(): string {
  return shownHostId(useConfigStore.getState().config);
}

export const useTodosStore = create<TodosState>((set, get) => ({
  snapshot: null,
  snapshotMachine: null,
  installIds: {},
  hostTodosOff: false,
  details: new Map(),
  watched: new Map(),
  snoozeRequest: null,
  requestSnooze: (key) => set({ snoozeRequest: key }),

  refresh: async () => {
    const api = todosApi();
    if (!api) return;
    const generation = ++refreshGeneration;
    const machine = shownNow();
    const response = await api.snapshot().catch(() => null);
    if (generation !== refreshGeneration) return;
    // The window switched computers while this read was out: the list it answered is the old one's (T-51).
    if (shownNow() !== machine) return;
    // The host turned To-dos off: forget what it showed, so every entry hides (T-39).
    if (response && !response.success && refusedAsOff(response.error)) { set({ snapshot: null, snapshotMachine: null, details: new Map(), hostTodosOff: true }); return; }
    if (!response?.success || !response.data) return;
    // Just after a switch, a read can still reach the computer the window left (T-51 F-1): its list is not the
    // shown computer's, so it waits for a read that is.
    if (!fromMachine(response.data, machine, get().installIds)) {
      if (generation === refreshGeneration && staleRetries < STALE_RETRY_LIMIT) {
        staleRetries += 1;
        setTimeout(() => { if (generation === refreshGeneration) void get().refresh(); }, STALE_RETRY_MS);
      }
      return;
    }
    staleRetries = 0;
    set({ snapshot: api.hostIsHere ? asHost(response.data, machine) : response.data, snapshotMachine: machine, hostTodosOff: false });
    // Only the shown computer's pages: one still open from before a switch is another machine's to-do.
    const shown = shownNow();
    await Promise.all([...get().watched.values()].filter(page => page.machineId === shown).map(page => get().loadDetail(page.number)));
  },

  loadDetail: async (number) => {
    const api = todosApi();
    if (!api) return null;
    // Reads overlap (an action's refresh and the change event): only the newest may land, or an older
    // answer would put back a to-do without what was just attached (round 8 CI, T-5).
    const machineId = shownNow();
    const key = todoKey(machineId, number);
    const generation = ++detailReads;
    detailGenerations.set(key, generation);
    const response = await api.detail(number).catch(() => null);
    // The window switched computers while this read was out (T-51): the answer is the old machine's, so it lands nowhere.
    if (shownNow() !== machineId) return null;
    if (detailGenerations.get(key) !== generation) return get().details.get(key) ?? null;
    if (!response?.success || !response.data) return null;
    // Stamped with its machine, so its layout memory and "Open its Session" name the right one (T-51). Main
    // sends none; a page that already names its machine keeps it.
    const read = api.hostIsHere ? detailAsHost(response.data, machineId) : response.data;
    const detail = { ...read, machineId: read.machineId ?? machineId };
    set(state => ({ details: new Map(state.details).set(key, detail) }));
    return detail;
  },

  watch: (number) => {
    const machineId = shownNow();
    const key = todoKey(machineId, number);
    set(state => ({ watched: new Map(state.watched).set(key, { machineId, number, count: (state.watched.get(key)?.count ?? 0) + 1 }) }));
    void get().loadDetail(number);
    return () => set(state => {
      const watched = new Map(state.watched);
      const page = watched.get(key);
      if (!page || page.count <= 1) watched.delete(key);
      else watched.set(key, { ...page, count: page.count - 1 });
      return { watched };
    });
  },

  create: async (input) => {
    if (refusedReadOnly()) return null;
    try {
      const api = todosApi();
      if (!api) throw new Error('To-dos are not available here.');
      const response = await api.create(input);
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
    if (refusedReadOnly()) return null;
    try {
      const api = todosApi();
      if (!api) throw new Error('To-dos are not available here.');
      const response = await api.act(action);
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

  desktop: null,
  remote: {},
  machines: [],
  setMachines: (machines) => {
    // In remote mode the list's own reads go to the computer this window shows; it is not listed again (T-8).
    const config = useConfigStore.getState().config;
    const saved = otherMachines(machines, config ? getActiveRemoteHostId(config.remoteDaemon) : null);
    const installIds = Object.fromEntries(machines.flatMap(machine => (machine.installId ? [[machine.id, machine.installId]] : [])));
    set(state => {
      const remote: Record<string, RemoteTodos> = {};
      for (const machine of saved) {
        const known = state.remote[machine.id];
        remote[machine.id] = { machineId: machine.id, label: machine.label, snapshot: known?.snapshot ?? null, offline: machine.status === 'offline' };
      }
      // Back on this computer: its to-dos are the store's own list again.
      return config && getActiveRemoteHostId(config.remoteDaemon) ? { machines: saved, remote, installIds } : { machines: saved, remote, installIds, desktop: null };
    });
  },
  refreshRemote: async (machineId) => {
    const api = window.electronAPI?.machines;
    if (!api || !isTodosEnabled(useConfigStore.getState().config)) return;
    const generation = remoteGeneration;
    // A read that lands after To-dos was turned off is dropped (T-51).
    const current = () => generation === remoteGeneration && isTodosEnabled(useConfigStore.getState().config);
    if ((machineId === undefined || machineId === LOCAL_MACHINE_ID) && shownHostId(useConfigStore.getState().config) !== LOCAL_MACHINE_ID) {
      void api.read(LOCAL_MACHINE_ID, 'todos:snapshot').then(read => read.data, () => null).then((response) => {
        if (current() && response?.success && response.data) set({ desktop: response.data });
      });
    }
    const targets = get().machines.filter(machine => (machineId === undefined || machine.id === machineId) && machine.status === 'online');
    await Promise.all(targets.map(async machine => {
      const response = await api.read(machine.id, 'todos:snapshot').then(read => read.data, () => null);
      // A machine whose Pane predates To-dos answers with an error: it has none.
      const snapshot = response?.success && response.data ? response.data : null;
      if (!current()) return;
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
    let latest: readonly MachineState[] = [];
    const applyMachines = (machines: readonly MachineState[]) => {
      latest = machines;
      const before = new Map(useTodosStore.getState().machines.map(machine => [machine.id, machine.status]));
      useTodosStore.getState().setMachines(machines);
      for (const machine of machines) {
        if (machine.kind === 'remote' && machine.status === 'online' && before.get(machine.id) !== 'online') schedule(machine.id);
      }
      // The window shows another computer: this computer's own to-dos are read too, for All machines (T-51).
      if (shownHostId(useConfigStore.getState().config) !== LOCAL_MACHINE_ID) schedule(LOCAL_MACHINE_ID);
    };
    const onEvent = (event: MachineConnectionsEvent) => {
      if (event.type === 'machines') applyMachines(event.machines);
      else if (event.type === 'resync') schedule(event.machineId);
      else if (REMOTE_TODO_EVENTS.has(event.channel)) schedule(event.machineId);
    };
    const unsubscribe = api.onEvent(onEvent);
    // The settings can arrive after the machines: which computer this window shows decides who is listed (T-8).
    const unsubscribeConfig = useConfigStore.subscribe((state, prior) => {
      if (state.config?.remoteDaemon !== prior.config?.remoteDaemon) applyMachines(latest);
    });
    api.list().then(machines => { if (!stopped) applyMachines(machines); }).catch(() => undefined);
    return () => {
      stopped = true;
      unsubscribe();
      unsubscribeConfig();
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

/**
 * The page of to-do `number` of the computer this window shows, kept current while it is on screen. Given
 * `machineId` (T-51 F-4), only that machine's: none while the window shows another, whose T-n is another to-do.
 */
export function useTodoDetail(number: number | null, machineId?: string): TodoDetail | null {
  const shown = useShownHostId();
  const key = number === null || (machineId !== undefined && machineId !== shown) ? null : todoKey(shown, number);
  const detail = useTodosStore(state => (key === null ? null : state.details.get(key) ?? null));
  const watch = useTodosStore(state => state.watch);
  // The key names the machine too: after a switch this watches the new computer's to-do, never the old one's.
  useEffect(() => (number === null || key === null ? undefined : watch(number)), [number, key, watch]);
  return detail;
}

/** To-do `number`'s page of the computer this window shows, as last read; none before it is read. */
export function todoDetailNow(number: number): TodoDetail | undefined {
  return useTodosStore.getState().details.get(todoKey(shownNow(), number));
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
  const enabled = useConfigStore(state => isTodosEnabled(state.config));
  useEffect(() => {
    if (enabled) {
      void useTodosStore.getState().refreshRemote();
      return watchTodos(refresh);
    }
    forgetTodos();
    return undefined;
  }, [refresh, enabled]);
}

/**
 * The desktop switched this window to another computer (All machines, T-37): forgets the outgoing host's
 * list and pages, so the to-do screens read as loading, then reads the incoming host. A to-do page open
 * on the outgoing computer closes (T-51): the incoming one's T-n with the same number is another to-do.
 * A read from the outgoing computer that lands late is dropped.
 */
export async function switchTodosHost(): Promise<void> {
  refreshGeneration += 1;
  staleRetries = 0;
  detailGenerations.clear();
  const selected = useNavigationStore.getState().selectedTodo;
  if (selected && selected.machineId !== shownNow()) useNavigationStore.getState().selectTodo(null);
  useTodosStore.setState({ snapshot: null, snapshotMachine: null, details: new Map() });
  await useTodosStore.getState().refresh();
}

/**
 * To-dos turned off (T-39): forgets every to-do read, here and from other machines, and drops the reads
 * still in flight (T-51), so none lands after. Nothing is deleted.
 */
export function forgetTodos(): void {
  remoteGeneration += 1;
  resetTodos();
  useTodosStore.setState(state => ({ desktop: null, remote: Object.fromEntries(Object.entries(state.remote).map(([id, machine]) => [id, { ...machine, snapshot: null }])) }));
}

/** Forgets every to-do read so far: the web app does this when it leaves a host. */
export function resetTodos(): void {
  refreshGeneration += 1;
  useTodosStore.setState({ snapshot: null, snapshotMachine: null, details: new Map(), watched: new Map(), hostTodosOff: false });
}

/**
 * Reads the snapshot now and again whenever the host says it changed, or an approval linked to a
 * to-do settles. Returns the stop. The desktop runs it for the app's life; the web app per host.
 */
export function watchTodos(refresh: () => Promise<void> = useTodosStore.getState().refresh): () => void {
  const api = todosApi();
  if (!api) return () => undefined;
  void refresh();
  const unsubscribe = api.onChanged(() => { void refresh(); });
  // A to-do's status follows its approvals: reread once an approval's state settles (an answer ends
  // the Undo hold as sent → answered), so the page never shows Waiting on you for an answered card.
  let approvals = approvalStates(useNotifyStore.getState().snapshot);
  let timer: number | undefined;
  const unsubscribeNotify = useNotifyStore.subscribe(state => {
    const next = approvalStates(state.snapshot);
    if (next === approvals) return;
    approvals = next;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void refresh(); }, 300);
  });
  return () => {
    unsubscribe();
    unsubscribeNotify();
    window.clearTimeout(timer);
  };
}

/** How this machine is named on its own screens, as the design shows it ("This Mac is busy"). */
export const THIS_MACHINE_LABEL = isMac() ? 'This Mac' : 'This computer';

/**
 * What the desktop calls machine `machine` (T-51 F-2): "This Mac" for this computer, else the name it is saved
 * under, as the To-dos list shows another machine. Undefined when it isn't a saved computer: the host's own name stays.
 */
function hostLabel(machine: string): string | undefined {
  if (machine === LOCAL_MACHINE_ID) return THIS_MACHINE_LABEL;
  return useConfigStore.getState().config?.remoteDaemon?.client.computers.find(computer => computer.id === machine)?.label;
}

/** The host names itself by hostname, for other machines' screens; the desktop names it as it knows it. */
function relabel(text: string, host: string, label: string): string;
function relabel(text: string | undefined, host: string, label: string): string | undefined;
function relabel(text: string | undefined, host: string, label: string): string | undefined {
  return text?.split(host).join(label);
}

function rowAs<Row extends TodoListRow>(row: Row, host: string, label: string): Row {
  return { ...row, machine: label, status: { ...row.status, reason: relabel(row.status.reason, host, label) } };
}

/** Machine `machine`'s list, named as the desktop names it. */
function asHost(snapshot: TodosSnapshot, machine: string): TodosSnapshot {
  const label = hostLabel(machine);
  if (!label) return snapshot;
  const host = snapshot.machine;
  return { ...snapshot, machine: label, gate: { ...snapshot.gate, line: relabel(snapshot.gate.line, host, label) }, rows: snapshot.rows.map(row => rowAs(row, host, label)) };
}

/** Machine `machine`'s to-do page, named as the desktop names it. */
function detailAsHost(detail: TodoDetail, machine: string): TodoDetail {
  const label = hostLabel(machine);
  if (!label) return detail;
  const host = detail.machine;
  return {
    ...rowAs(detail, host, label),
    subTodos: detail.subTodos.map(row => rowAs(row, host, label)),
    parent: detail.parent ? rowAs(detail.parent, host, label) : undefined,
    load: { ...detail.load, reason: relabel(detail.load.reason, host, label) },
  };
}

/** Each approval linked to a to-do, with its state: what a to-do's status reads from Approvals. */
function approvalStates(snapshot: NotifySnapshot | null): string {
  return (snapshot?.items ?? []).filter(item => item.todo).map(item => `${item.id}:${item.state}`).join(',');
}

export function useShownHostId(): string {
  return useConfigStore(state => shownHostId(state.config));
}

/**
 * Which machine a Session's to-dos are on (T-51), by the id its cards carry: the machine given (All machines
 * names each row's), else the computer this window shows, whose to-dos are the store's own list. Every
 * Session's approval scope goes through here, so no caller picks the machine by hand.
 */
export function sessionTodoMachine(machineId: string | undefined, shownHost: string): string {
  return machineId ?? shownHost;
}

/**
 * The to-do rows of machine `machine` (a `sessionTodoMachine` id): the shown host's own list, this computer's
 * while the window shows another (`desktop`), or a saved machine's.
 */
function machineRows(state: Pick<TodosState, 'snapshot' | 'snapshotMachine' | 'desktop' | 'remote'>, machine: string, shownHost: string): readonly TodoListRow[] | undefined {
  if (machine === shownHost) return shownSnapshot(state, shownHost)?.rows;
  return machine === LOCAL_MACHINE_ID ? state.desktop?.rows : state.remote[machine]?.snapshot?.rows;
}

/** The list of the computer the window shows, once it is read from that computer; null until then (T-51 F-1). */
export function shownSnapshot(state: Pick<TodosState, 'snapshot' | 'snapshotMachine'>, shownHost: string): TodosSnapshot | null {
  return state.snapshotMachine === shownHost ? state.snapshot : null;
}

/** A Session's to-dos' approvals scope (T-22), read once from the store's current state. */
export function sessionTodoScope(sessionId: string, machineId?: string): TodoApprovalScope {
  const shownHost = shownHostId(useConfigStore.getState().config);
  const machine = sessionTodoMachine(machineId, shownHost);
  // To-dos off: no to-do brings a card, whatever a late read left in the store (T-51).
  if (!todosEnabledNow()) return emptyTodoScope(machine);
  return todoApprovalScope(machineRows(useTodosStore.getState(), machine, shownHost) ?? [], sessionId, machine);
}

/** As sessionTodoScope, kept current: its row's count and its Approvals column include its to-dos' approvals. */
export function useSessionTodoScope(sessionId: string, machineId?: string): TodoApprovalScope {
  const shownHost = useShownHostId();
  const machine = sessionTodoMachine(machineId, shownHost);
  const rows = useTodosStore(state => machineRows(state, machine, shownHost));
  const enabled = useTodosEnabled();
  return useMemo(() => (enabled ? todoApprovalScope(rows ?? [], sessionId, machine) : emptyTodoScope(machine)), [enabled, rows, sessionId, machine]);
}

/** No to-dos, only the machine whose cards a Session takes: for a count that leaves its to-dos out. */
export function useSessionMachineScope(machineId?: string): TodoApprovalScope {
  const machine = sessionTodoMachine(machineId, useShownHostId());
  return useMemo(() => emptyTodoScope(machine), [machine]);
}

/**
 * How a card names its to-do (T-51): "T-28" when it is on the computer this window shows, else with the
 * machine beside it, by the name it is saved under ("T-28 · tylers-macbook-pro"), as the To-dos list does.
 */
export function todoRefOfItem(item: Pick<NotifyItem, 'machineId' | 'machine' | 'todo'>): string | undefined {
  if (!item.todo) return undefined;
  const machine = machineOfItem(item);
  if (machine === shownHostId(useConfigStore.getState().config)) return todoRefOn(item.todo.number);
  const label = machine === LOCAL_MACHINE_ID ? THIS_MACHINE_LABEL : useTodosStore.getState().machines.find(saved => saved.id === machine)?.label;
  return todoRefOn(item.todo.number, label ?? item.machine ?? machine);
}

/** Whether a snooze request is for to-do `number` on the computer this window shows. */
export function snoozeRequestedFor(request: TodoKey | null, number: number): boolean {
  return request !== null && request === todoKey(shownHostId(useConfigStore.getState().config), number);
}

/** A Session's to-dos (T-23) as list entries, kept current; null until that machine's to-dos are read. */
export function useSessionTodoEntries(sessionId: string, machineId?: string): TodoEntry[] | null {
  const shownHost = useShownHostId();
  const machine = sessionTodoMachine(machineId, shownHost);
  const rows = useTodosStore(state => machineRows(state, machine, shownHost));
  // Keyed by the machine its approval scope uses (T-51), so a row and its cards name the same to-do.
  return useMemo(() => (rows ? sessionTodoEntries(rows, sessionId, machine) : null), [rows, sessionId, machine]);
}

/** As useSessionTodoEntries, read once from the store's current state. */
export function sessionTodoEntriesNow(sessionId: string, machineId?: string): TodoEntry[] | null {
  const shownHost = shownHostId(useConfigStore.getState().config);
  const machine = sessionTodoMachine(machineId, shownHost);
  const rows = machineRows(useTodosStore.getState(), machine, shownHost);
  return rows ? sessionTodoEntries(rows, sessionId, machine) : null;
}

/** The approvals waiting on you for a Session's to-dos: oldest first, and how many each of its to-dos has. */
export interface SessionTodoApprovals {
  items: NotifyItem[];
  /** By top-level to-do, keyed on `machineId`; a sub-to-do's count is its parent's. */
  byTodo: ReadonlyMap<TodoKey, number>;
  /** The machine the Session's to-dos are on (`sessionTodoMachine`), to key a row with `todoKeyOfRow`. */
  machineId: string;
}

/**
 * The approvals of a Session's to-dos waiting on you (T-23, T-37), from the machine those to-dos are on
 * (`sessionTodoMachine`): desktop Notify lists every saved machine's cards together, and two machines each
 * have a T-14, so the scope takes only that machine's. The tabs' counts, the rows' counts and the approval
 * pager all read this one set.
 */
export function useSessionTodoApprovals(sessionId: string, machineId?: string): SessionTodoApprovals {
  const items = useNotifyStore(selectNotifyItems);
  const shownHost = useShownHostId();
  const machine = sessionTodoMachine(machineId, shownHost);
  const rows = useTodosStore(state => machineRows(state, machine, shownHost));
  const scope = useSessionTodoScope(sessionId, machineId);
  return useMemo(() => {
    const waiting = sessionTodoApprovals(items, scope).sort(newestFirst);
    return { items: waiting, byTodo: approvalsByTodo(waiting, rows ?? [], machine), machineId: machine };
  }, [items, rows, scope, machine]);
}

/** A Session's To-dos tab's amber count (T-23): its to-dos' approvals waiting on you, each once. */
export function useSessionTodosWaiting(sessionId: string, machineId?: string): number {
  return useSessionTodoApprovals(sessionId, machineId).items.length;
}
