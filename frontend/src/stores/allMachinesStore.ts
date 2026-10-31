import { create } from 'zustand';
import { API, type IPCResponse } from '../utils/api';
import type { MachineRef, MachineSnapshot, MachineView } from '../utils/allMachinesTree';
import type { MachineSelectOutcome } from '../hooks/useMachines';
import {
  type MachineConnectionsEvent,
  type MachineEventChannel,
  type MachineState,
} from '../../../shared/types/machineConnections';

/** The local preference that keeps the sidebar in All machines across relaunch. */
const ALL_MACHINES_PREFERENCE = 'sidebar_all_machines';
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

interface AllMachinesState {
  /** The sidebar shows every machine's rows. */
  enabled: boolean;
  /** Every machine 1.2 knows: this computer and each saved machine. */
  machines: MachineState[];
  snapshots: Record<string, MachineSnapshot>;
  /** The pill menu's machines, for names, OS and colour. */
  entries: MachineEntryRef[];
  /** Today's switch, registered by the sidebar that owns the machine menu. */
  switchMachine: ((machineId: string) => Promise<MachineSelectOutcome>) | null;
  /** Shown in place of the Pane view after opening a row on an offline machine. */
  offlineNotice: OfflineNotice | null;
  /** Bumped when a machine's offline grace ends, so its rows dim on time. */
  clock: number;
  setEnabled: (enabled: boolean) => void;
  hydrate: () => Promise<void>;
}

export const useAllMachinesStore = create<AllMachinesState>((set) => ({
  enabled: false,
  machines: [],
  snapshots: {},
  entries: [],
  switchMachine: null,
  offlineNotice: null,
  clock: 0,
  setEnabled: (enabled) => {
    set({ enabled, offlineNotice: null });
    API.preferences.set(ALL_MACHINES_PREFERENCE, String(enabled)).catch((error) => {
      console.warn('[allMachines] Could not remember the sidebar mode:', error);
    });
  },
  hydrate: async () => {
    try {
      const response = await API.preferences.get(ALL_MACHINES_PREFERENCE);
      set({ enabled: response === 'true' });
    } catch (error) {
      console.warn('[allMachines] Could not read the sidebar mode:', error);
    }
  },
}));

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

/** Offline past its grace: its rows dim and opening one says so. */
export function isMachineDimmed(machine: MachineState | undefined, now = Date.now()): boolean {
  if (!machine || machine.status !== 'offline') return false;
  const since = Date.parse(machine.offlineSince ?? '');
  return !Number.isFinite(since) || now - since >= OFFLINE_GRACE_MS;
}

/** Each machine with its lists and whether its rows are from when it stopped answering. */
export function machineViews(state: Pick<AllMachinesState, 'machines' | 'snapshots' | 'entries'>, now = Date.now()): MachineView[] {
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  return state.machines.map((machine) => ({
    machine: entries.get(machine.id) ?? { id: machine.id, name: machine.label, os: null, slot: 0 },
    snapshot: state.snapshots[machine.id] ?? null,
    offline: isMachineDimmed(machine, now),
  }));
}
