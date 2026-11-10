import { create } from 'zustand';
import { API, type IPCResponse } from '../utils/api';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { useErrorStore } from './errorStore';
import { seedArrangement, type MachineRef, type MachineSnapshot, type MachineView, type SeededArrangement } from '../utils/allMachinesTree';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { machineLetter } from '../../../shared/utils/machineMarks';
import type { MachineSelectOutcome } from '../hooks/useMachines';
import {
  type MachineConnectionsEvent,
  type MachineEventChannel,
  type MachineState,
} from '../../../shared/types/machineConnections';

/** The local preference that keeps the sidebar in All machines across relaunch. */
const ALL_MACHINES_PREFERENCE = 'sidebar_all_machines';
/** How this computer arranged All machines; never sent to another machine. */
const ALL_MACHINES_LAYOUT_PREFERENCE = 'sidebar_all_machines_layout';
/** Events arrive in bursts; one read per machine covers a burst. */
const MACHINE_REREAD_DEBOUNCE_MS = 250;
/** A machine reconnecting for less than this keeps its rows bright, so a blip never flickers. */
const OFFLINE_GRACE_MS = 3_000;
/** A read that has not answered by then leaves that machine's rows as they were. */
const READ_TIMEOUT_MS = 10_000;

type ReadKey = keyof MachineSnapshot;

/** The data of an IPC answer; a failed answer is a failed read. */
function answered<T>(response: IPCResponse<T>): T | undefined {
  if (!response.success) throw new Error(response.error ?? 'The read failed.');
  return response.data;
}

/** Each list of a machine and the `machines:read` that fills it. */
const READERS = {
  projects: async (id: string) => answered((await window.electronAPI.machines.read(id, 'sessions:get-all-with-projects')).data) ?? [],
  sessions: async (id: string) => answered((await window.electronAPI.machines.read(id, 'orchestration-sessions:list')).data)?.sessions ?? [],
  statuses: async (id: string) => answered((await window.electronAPI.machines.read(id, 'panels:agent-statuses')).data) ?? [],
  notify: async (id: string) => (await window.electronAPI.machines.read(id, 'notify:remote-snapshot')).data ?? null,
  permissions: async (id: string) => answered((await window.electronAPI.machines.read(id, 'permission:getPending')).data) ?? [],
} satisfies { [Key in ReadKey]: (machineId: string) => Promise<MachineSnapshot[Key]> };
const ALL_READS: ReadKey[] = ['projects', 'sessions', 'statuses', 'notify', 'permissions'];

/** Which of a machine's lists each event changes. */
const READS_FOR_EVENT = {
  'session:created': ['projects'],
  'session:updated': ['projects'],
  'session:deleted': ['projects', 'sessions'],
  'sessions:loaded': ['projects'],
  'panel:created': ['statuses'],
  'panel:updated': [],
  'panel:deleted': ['statuses'],
  'panel:agentStatus': ['statuses'],
  // Emitted with each panel:agentStatus, which already re-reads statuses.
  'panel:activityStatus': [],
  'orchestration-sessions:changed': ['sessions'],
  'project:updated': ['projects'],
  'project:list-changed': ['projects'],
  'permission:request': ['permissions'],
  'permission:resolved': ['permissions'],
  'notify:shared-changed': ['notify'],
  'remote:settings-changed': [],
} satisfies Record<MachineEventChannel, ReadKey[]>;

/** A machine as the pill menu knows it, plus whether the app is on it. */
interface MachineEntryRef extends MachineRef {
  active: boolean;
}

interface OfflineNotice {
  machineId: string;
  title: string;
  /** The question it was waiting on you with when it stopped answering. */
  question: string | null;
}

/**
 * This computer's All machines arrangement and what is open in it. `open` holds
 * `section:sessions`, `section:projects`, `project:<project key>` and `session:<row key>`;
 * a project or Session it does not name is closed. `seeded` names the machines whose first look
 * is in the order (see `seedArrangement`).
 */
export interface AllMachinesLayout extends SeededArrangement {
  open: string[];
}

const DEFAULT_LAYOUT: AllMachinesLayout = { sessions: null, panes: {}, open: ['section:sessions', 'section:projects'], seeded: [] };

const layoutSchema = boundary.object({
  sessions: boundary.nullable(boundary.array(boundary.string)),
  panes: boundary.record(boundary.array(boundary.string)),
  open: boundary.array(boundary.string),
  seeded: boundary.optional(boundary.array(boundary.string)),
});

/** The saved layout, or the default one when nothing is saved or it cannot be read. */
function readLayout(value: string | null): AllMachinesLayout {
  if (!value) return DEFAULT_LAYOUT;
  try {
    const layout = decodeBoundary(JSON.parse(value), layoutSchema);
    return { ...layout, seeded: layout.seeded ?? [] };
  } catch (error) {
    console.warn('[allMachines] The saved layout could not be read, so it starts fresh:', error);
    return DEFAULT_LAYOUT;
  }
}

interface AllMachinesState {
  /** The sidebar shows every machine's rows. */
  enabled: boolean;
  /** Every machine 1.2 knows: this computer and each saved machine. */
  machines: MachineState[];
  snapshots: Record<string, MachineSnapshot>;
  /** The pill menu's machines, for names, OS and colour. */
  entries: MachineEntryRef[];
  /** The sidebar shows the machine menu, the only control that leaves All machines. */
  menuShown: boolean;
  /** Today's switch, registered by the sidebar that owns the machine menu. */
  switchMachine: ((machineId: string) => Promise<MachineSelectOutcome>) | null;
  /** Today's password prompt for a machine that asks for one, registered by the same sidebar. */
  askMachinePassword: ((machineName: string) => void) | null;
  /** Shown in place of the Pane view after opening a row on an offline machine. */
  offlineNotice: OfflineNotice | null;
  /** Bumped when a machine's offline grace ends, so its rows dim on time. */
  clock: number;
  /** This computer's arrangement and open rows. */
  layout: AllMachinesLayout;
  setEnabled: (enabled: boolean) => void;
  hydrate: () => Promise<void>;
  /** Saves the Session rows' order, keys across machines. */
  arrangeSessions: (order: string[]) => void;
  /** Saves one project's Pane rows' order. */
  arrangePanes: (projectKey: string, order: string[]) => void;
  /** Opens or closes a section, project or Session row (see `AllMachinesLayout.open`). */
  toggleOpen: (key: string) => void;
  /** Takes the first look of each machine whose list has now answered into the arrangement. */
  takeFirstLooks: (answered: (machineId: string, list: 'sessions' | 'projects') => boolean) => void;
}

export const useAllMachinesStore = create<AllMachinesState>((set, get) => {
  /**
   * Shows the layout now and saves it on this computer. A move or open/close you made that
   * cannot be saved says so: it stays on screen until Pane restarts, then the last saved
   * arrangement returns. A first look that cannot be saved is taken again next launch.
   */
  const saveLayout = (layout: AllMachinesLayout, yours = true) => {
    set({ layout });
    const notSaved = (reason: string) => {
      console.warn('[allMachines] Could not remember the arrangement:', reason);
      if (!yours) return;
      useErrorStore.getState().showError({
        title: 'Your All machines arrangement was not saved',
        error: `${reason} The change shows until Pane restarts, then the last saved arrangement comes back. Make the change again to try saving it.`,
      });
    };
    const reasonOf = (error: Error | string | null) => ipcErrorMessage(error, 'This computer could not save it.');
    try {
      API.preferences.set(ALL_MACHINES_LAYOUT_PREFERENCE, JSON.stringify(layout)).catch((error: Error) => notSaved(reasonOf(error)));
    } catch (error) {
      notSaved(reasonOf(error instanceof Error ? error : String(error)));
    }
  };
  return {
  enabled: false,
  machines: [],
  snapshots: {},
  entries: [],
  menuShown: false,
  switchMachine: null,
  askMachinePassword: null,
  offlineNotice: null,
  clock: 0,
  layout: DEFAULT_LAYOUT,
  setEnabled: (enabled) => {
    set({ enabled, offlineNotice: null });
    API.preferences.set(ALL_MACHINES_PREFERENCE, String(enabled)).catch((error) => {
      console.warn('[allMachines] Could not remember the sidebar mode:', error);
    });
  },
  hydrate: async () => {
    try {
      const [enabled, layout] = await Promise.all([
        API.preferences.get(ALL_MACHINES_PREFERENCE),
        API.preferences.get(ALL_MACHINES_LAYOUT_PREFERENCE),
      ]);
      set({ enabled: enabled === 'true', layout: readLayout(layout) });
    } catch (error) {
      console.warn('[allMachines] Could not read the sidebar mode:', error);
    }
  },
  arrangeSessions: (order) => saveLayout({ ...get().layout, sessions: order }),
  arrangePanes: (projectKey, order) => {
    const { layout } = get();
    saveLayout({ ...layout, panes: { ...layout.panes, [projectKey]: order } });
  },
  takeFirstLooks: (answered) => {
    const state = get();
    const next = seedArrangement(state.layout, machineViews(state), answered);
    if (next) saveLayout({ ...state.layout, ...next }, false);
  },
  toggleOpen: (key) => {
    const { layout } = get();
    saveLayout({ ...layout, open: layout.open.includes(key) ? layout.open.filter((item) => item !== key) : [...layout.open, key] });
  },
  };
});

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('The machine did not answer in time.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const EMPTY_SNAPSHOT: MachineSnapshot = { projects: [], sessions: [], statuses: [], notify: null, permissions: [] };

/**
 * Keeps every machine's lists current while All machines is on: reads each machine once,
 * then re-reads one machine, and only the lists its events touched, a moment after they
 * arrive. A resync re-reads that machine whole. Each list has at most one read in flight;
 * events that arrive meanwhile read it once more when it settles. Returns the stop function.
 */
export function startAllMachinesFeed(): () => void {
  const pending = new Map<string, { keys: Set<ReadKey>; timer: ReturnType<typeof setTimeout> }>();
  /** `<machine id>\n<list>` of each read in flight, and of each one asked for again meanwhile. */
  const inFlight = new Set<string>();
  const again = new Set<string>();
  /** `<machine id>\n<list>` of each list that has answered at least once. */
  const answered = new Set<string>();
  let stopped = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const readList = async (machineId: string, key: ReadKey): Promise<void> => {
    const list = `${machineId}\n${key}`;
    if (inFlight.has(list)) {
      again.add(list);
      return;
    }
    inFlight.add(list);
    try {
      // A read that times out is dropped, so a newer read of the list never meets an older answer.
      const value = await withTimeout<MachineSnapshot[ReadKey]>(READERS[key](machineId), READ_TIMEOUT_MS);
      if (stopped) return;
      useAllMachinesStore.setState((state) => {
        // A machine removed while its read was in flight stays removed.
        if (!state.machines.some((machine) => machine.id === machineId)) return state;
        return { snapshots: { ...state.snapshots, [machineId]: { ...EMPTY_SNAPSHOT, ...state.snapshots[machineId], [key]: value } } };
      });
      if (useAllMachinesStore.getState().machines.some((machine) => machine.id === machineId)) {
        answered.add(list);
        useAllMachinesStore.getState().takeFirstLooks((id, which) => answered.has(`${id}\n${which}`));
      }
    } catch (error) {
      console.warn(`[allMachines] Could not read ${key} from ${machineId}:`, error);
    } finally {
      inFlight.delete(list);
      if (again.delete(list) && !stopped) void readList(machineId, key);
    }
  };
  const readMachine = (machineId: string, keys: Iterable<ReadKey>) => {
    for (const key of keys) void readList(machineId, key);
  };

  const schedule = (machineId: string, keys: readonly ReadKey[]) => {
    if (stopped || keys.length === 0) return;
    const entry = pending.get(machineId);
    if (entry) {
      for (const key of keys) entry.keys.add(key);
      return;
    }
    const next = { keys: new Set(keys), timer: setTimeout(() => {
      pending.delete(machineId);
      if (!stopped) readMachine(machineId, next.keys);
    }, MACHINE_REREAD_DEBOUNCE_MS) };
    pending.set(machineId, next);
  };

  // Ticks once a machine's grace ends, so its rows dim without waiting for another event.
  const scheduleGraceTick = (machines: MachineState[]) => {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = null;
    const now = Date.now();
    let soonest = Infinity;
    for (const machine of machines) {
      if (machine.status !== 'offline' || !machine.offlineSince) continue;
      const wait = Date.parse(machine.offlineSince) + OFFLINE_GRACE_MS - now;
      if (wait > 0) soonest = Math.min(soonest, wait);
    }
    if (soonest === Infinity) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (!stopped) useAllMachinesStore.setState((state) => ({ clock: state.clock + 1 }));
    }, soonest + 10);
  };

  const setMachines = (machines: MachineState[]) => {
    const { snapshots, machines: before } = useAllMachinesStore.getState();
    const known = new Set(before.map((machine) => machine.id));
    const ids = new Set(machines.map((machine) => machine.id));
    const kept = Object.fromEntries(Object.entries(snapshots).filter(([id]) => ids.has(id)));
    const notice = useAllMachinesStore.getState().offlineNotice;
    // The machine answers again, so its row can be opened.
    useAllMachinesStore.setState({ machines, snapshots: kept });
    if (notice && machines.find((machine) => machine.id === notice.machineId)?.status === 'online') {
      useAllMachinesStore.setState({ offlineNotice: null });
    }
    scheduleGraceTick(machines);
    for (const machine of machines) {
      // A machine seen for the first time is read at once; only events wait for their burst.
      if (!known.has(machine.id)) readMachine(machine.id, ALL_READS);
    }
  };

  const onEvent = (event: MachineConnectionsEvent) => {
    if (event.type === 'machines') setMachines(event.machines);
    else if (event.type === 'resync') schedule(event.machineId, ALL_READS);
    else schedule(event.machineId, READS_FOR_EVENT[event.channel] ?? ALL_READS);
  };

  const unsubscribe = window.electronAPI.machines.onEvent(onEvent);
  useAllMachinesStore.setState({ machines: [], snapshots: {} });
  window.electronAPI.machines.list().then((machines) => { if (!stopped) setMachines(machines); }).catch((error) => {
    console.warn('[allMachines] Could not list machines:', error);
  });

  return () => {
    stopped = true;
    unsubscribe();
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    again.clear();
    if (graceTimer) clearTimeout(graceTimer);
  };
}

/** All machines is on and its menu is shown: with the menu hidden, today's sidebar shows, so the mode can't trap you. */
export function isAllMachinesOn(state: Pick<AllMachinesState, 'enabled' | 'menuShown'>): boolean {
  return state.enabled && state.menuShown;
}

/** Offline past its grace: its rows dim and opening one says so. */
export function isMachineDimmed(machine: MachineState | undefined, now = Date.now()): boolean {
  if (!machine || machine.status !== 'offline') return false;
  const since = Date.parse(machine.offlineSince ?? '');
  return !Number.isFinite(since) || now - since >= OFFLINE_GRACE_MS;
}

/** Each machine, in the machine menu's order, with its lists and whether its rows are from when it stopped answering. */
export function machineViews(state: Pick<AllMachinesState, 'machines' | 'snapshots' | 'entries'>, now = Date.now()): MachineView[] {
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  const menuPlace = new Map(state.entries.map((entry, index) => [entry.id, index]));
  const place = (id: string) => menuPlace.get(id) ?? state.entries.length;
  return [...state.machines].sort((a, b) => place(a.id) - place(b.id)).map((machine) => ({
    machine: entries.get(machine.id) ?? { id: machine.id, name: machine.label, os: null, slot: 0, letters: machineLetter(machine.label) },
    snapshot: state.snapshots[machine.id] ?? null,
    offline: isMachineDimmed(machine, now),
  }));
}
