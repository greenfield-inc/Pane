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
import { isTodosEnabled, useConfigStore } from './configStore';
import type { AppConfig } from '../types/config';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { showActionError } from './errorStore';
import { selectNotifyItems, sessionTodoApprovals, useNotifyStore } from './notifyStore';
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
    files: {
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
  /** The host answered that To-dos is turned off (T-39), as opposed to not read yet: open To-dos screens close. */
  hostTodosOff: boolean;
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

let refreshGeneration = 0;
/** Bumped when To-dos turns off (T-51): a saved machine's read still in flight then lands nowhere. */
let remoteGeneration = 0;
/** Each to-do's newest detail read, so an older answer never replaces a newer one. */
const detailGenerations = new Map<number, number>();

export const useTodosStore = create<TodosState>((set, get) => ({
  snapshot: null,
  hostTodosOff: false,
  details: new Map(),
  watched: new Map(),
  snoozeRequest: null,
  requestSnooze: (key) => set({ snoozeRequest: key }),

  refresh: async () => {
    const api = todosApi();
    if (!api) return;
    const generation = ++refreshGeneration;
    const response = await api.snapshot().catch(() => null);
    if (generation !== refreshGeneration) return;
    // The host turned To-dos off: forget what it showed, so every entry hides (T-39).
    if (response && !response.success && refusedAsOff(response.error)) { set({ snapshot: null, details: new Map(), hostTodosOff: true }); return; }
    if (!response?.success || !response.data) return;
    set({ snapshot: api.hostIsHere ? asThisMachine(response.data) : response.data, hostTodosOff: false });
    await Promise.all([...get().watched.keys()].map(number => get().loadDetail(number)));
  },

  loadDetail: async (number) => {
    const api = todosApi();
    if (!api) return null;
    // Reads overlap (an action's refresh and the change event): only the newest may land, or an older
    // answer would put back a to-do without what was just attached (round 8 CI, T-5).
    const generation = (detailGenerations.get(number) ?? 0) + 1;
    detailGenerations.set(number, generation);
    const response = await api.detail(number).catch(() => null);
    if (detailGenerations.get(number) !== generation) return get().details.get(number) ?? null;
    if (!response?.success || !response.data) return null;
    const detail = api.hostIsHere ? detailAsThisMachine(response.data) : response.data;
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
    set(state => {
      const remote: Record<string, RemoteTodos> = {};
      for (const machine of saved) {
        const known = state.remote[machine.id];
        remote[machine.id] = { machineId: machine.id, label: machine.label, snapshot: known?.snapshot ?? null, offline: machine.status === 'offline' };
      }
      // Back on this computer: its to-dos are the store's own list again.
      return config && getActiveRemoteHostId(config.remoteDaemon) ? { machines: saved, remote } : { machines: saved, remote, desktop: null };
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
 * list and pages, so the to-do screens read as loading, then reads the incoming host. Pages still open
 * stay watched, so the read brings back theirs. An older read that lands late is dropped.
 */
export async function switchTodosHost(): Promise<void> {
  refreshGeneration += 1;
  detailGenerations.clear();
  useTodosStore.setState({ snapshot: null, details: new Map() });
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
  useTodosStore.setState({ snapshot: null, details: new Map(), watched: new Map(), hostTodosOff: false });
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

/** The host names itself by hostname, for other machines' screens; here it reads "This Mac". */
function relabel(text: string, host: string): string;
function relabel(text: string | undefined, host: string): string | undefined;
function relabel(text: string | undefined, host: string): string | undefined {
  return text?.split(host).join(THIS_MACHINE_LABEL);
}

function rowAsThisMachine<Row extends TodoListRow>(row: Row, host: string): Row {
  return { ...row, machine: THIS_MACHINE_LABEL, status: { ...row.status, reason: relabel(row.status.reason, host) } };
}

function asThisMachine(snapshot: TodosSnapshot): TodosSnapshot {
  const host = snapshot.machine;
  return { ...snapshot, machine: THIS_MACHINE_LABEL, gate: { ...snapshot.gate, line: relabel(snapshot.gate.line, host) }, rows: snapshot.rows.map(row => rowAsThisMachine(row, host)) };
}

function detailAsThisMachine(detail: TodoDetail): TodoDetail {
  const host = detail.machine;
  return {
    ...rowAsThisMachine(detail, host),
    subTodos: detail.subTodos.map(row => rowAsThisMachine(row, host)),
    parent: detail.parent ? rowAsThisMachine(detail.parent, host) : undefined,
    load: { ...detail.load, reason: relabel(detail.load.reason, host) },
  };
}

/** Each approval linked to a to-do, with its state: what a to-do's status reads from Approvals. */
function approvalStates(snapshot: NotifySnapshot | null): string {
  return (snapshot?.items ?? []).filter(item => item.todo).map(item => `${item.id}:${item.state}`).join(',');
}

/** The computer this window shows: this one (`local`), or the saved machine it was switched to (All machines, T-37). */
export function shownHostId(config: AppConfig | null): string {
  return getActiveRemoteHostId(config?.remoteDaemon) ?? LOCAL_MACHINE_ID;
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
function machineRows(state: Pick<TodosState, 'snapshot' | 'desktop' | 'remote'>, machine: string, shownHost: string): readonly TodoListRow[] | undefined {
  if (machine === shownHost) return state.snapshot?.rows;
  return machine === LOCAL_MACHINE_ID ? state.desktop?.rows : state.remote[machine]?.snapshot?.rows;
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
  /** By top-level to-do number; a sub-to-do's count is its parent's. */
  byTodo: ReadonlyMap<number, number>;
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
  const rows = useTodosStore(state => machineRows(state, sessionTodoMachine(machineId, shownHost), shownHost));
  const scope = useSessionTodoScope(sessionId, machineId);
  return useMemo(() => {
    const waiting = sessionTodoApprovals(items, scope).sort((a, b) => a.createdAt - b.createdAt);
    return { items: waiting, byTodo: approvalsByTodo(waiting, rows ?? []) };
  }, [items, rows, scope]);
}

/** A Session's To-dos tab's amber count (T-23): its to-dos' approvals waiting on you, each once. */
export function useSessionTodosWaiting(sessionId: string, machineId?: string): number {
  return useSessionTodoApprovals(sessionId, machineId).items.length;
}
