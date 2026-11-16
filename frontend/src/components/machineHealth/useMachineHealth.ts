import { useCallback, useEffect, useRef, useState } from 'react';
import type { CleanupRun, HealthProcess, MachineHealthSnapshot, OtherApp, StorageInventory } from '../../../../shared/types/machineHealth';
import { MACHINE_HEALTH_CHANGED_EVENT, MACHINE_HEALTH_INVENTORY_CHANGED_EVENT } from '../../../../shared/types/machineHealth';
import type { MachineHealthAction, MachineReadChannel, MachineState } from '../../../../shared/types/machineConnections';
import { healthReadProblem, type HealthReadProblem } from './healthReadError';
import { boundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';

/** One finished Pane as main lists it. */
export interface FinishedPaneRow {
  sessionId: string;
  name: string;
  projectName: string;
  reason: 'pr-merged' | 'pr-closed' | 'folder-missing' | 'idle';
  prNumber?: number;
  idleDays: number;
  sizeBytes: number | null;
  protection: string | null;
}

/** Memory relief on a machine. Fields a Pane before them leaves out are optional. */
interface ReliefRead {
  /** Panes "Pause idle Panes" would pause, and the idle hours it uses. */
  idle: { paneIds: string[]; memoryMB: number; hours?: number };
  leftBehind: HealthProcess[];
  /** Leaking pids Restart can serve: run-script processes whose script is running. */
  restartable?: number[];
  /** False when another Pane owns that machine's data folder, so this one runs no cleanup. */
  housekeeping?: boolean;
}

export interface MachineHealthData {
  snapshot: MachineHealthSnapshot;
  inventory: StorageInventory | null;
  finished: FinishedPaneRow[];
  relief: ReliefRead;
  history: CleanupRun[];
  readAt: number;
  /** True while the reads after the snapshot are still settling; their fields hold the last answer or an empty one. */
  pending: boolean;
}

type MachineHealthState =
  | { status: 'loading' }
  | { status: 'ready'; data: MachineHealthData }
  /** Unreachable or too old: the last data read, if any, stays on screen with its age. */
  | { status: 'problem'; problem: HealthReadProblem; last: MachineHealthData | null };

/** The last data read per machine, so an offline machine still shows something. */
const lastRead = new Map<string, MachineHealthData>();

/** Screens showing live numbers read again this often while open. */
export const HEALTH_POLL_MS = 60_000;

async function read<T>(machineId: string, channel: MachineReadChannel, args: unknown[] = []): Promise<T> {
  // SAFETY: each machine health channel returns the shared type named for it; main builds these values.
  return (await window.electronAPI.machines.read(machineId, channel, args)).data as T;
}

const levelSchema = boundary.enumeration('ok', 'warning', 'critical');
/** The fields every screen reads first; an answer without them is not a health snapshot. */
const healthSnapshotSchema = boundary.object({
  disk: boundary.object({ level: levelSchema, volumes: boundary.array(boundary.object({ freeBytes: boundary.number, totalBytes: boundary.number })) }),
  memory: boundary.object({ level: levelSchema, totalBytes: boundary.number, freeBytes: boundary.number }),
  panes: boundary.array(boundary.jsonObject),
});

/** The slower reads, each settling on its own; a failed one keeps the empty answer. */
function readRest(machineId: string, refresh: boolean): Array<Promise<Partial<MachineHealthData>>> {
  return [
    read<StorageInventory | null>(machineId, 'resource-monitor:machine-inventory', [{ refresh }]).then(inventory => ({ inventory }), () => ({})),
    read<FinishedPaneRow[]>(machineId, 'resource-monitor:machine-finished-panes').then(finished => ({ finished }), () => ({})),
    read<ReliefRead>(machineId, 'resource-monitor:machine-relief').then(relief => ({ relief }), () => ({})),
    read<CleanupRun[]>(machineId, 'resource-monitor:machine-cleanup-history').then(history => ({ history }), () => ({})),
  ];
}

/** Runs a machine health action on a machine (this one is `local`), through that machine's own checks. */
export async function runHealthAction(machineId: string, action: MachineHealthAction, request: JsonObject): Promise<void> {
  await window.electronAPI.machines.run(machineId, { type: 'machine-health', action, request });
}

/** The apps running outside Pane on a machine, biggest memory first. */
export async function readOtherApps(machineId: string): Promise<OtherApp[]> {
  return read<OtherApp[]>(machineId, 'resource-monitor:machine-apps');
}

/** One machine's latest health sample. */
export async function readHealthSnapshot(machineId: string): Promise<MachineHealthSnapshot> {
  const data = (await window.electronAPI.machines.read(machineId, 'resource-monitor:machine-health')).data;
  if (!decodeOptionalBoundary(data, healthSnapshotSchema)) {
    throw new PaneError('ERR_MACHINE_HEALTH_UNREADABLE', 'This machine answered with something that is not a health snapshot.', 'Update Pane on this machine, then open Resources again.');
  }
  // SAFETY: the shape check above confirmed the snapshot fields screens read; main builds the rest of the value.
  return data as MachineHealthSnapshot;
}

export interface UseMachineHealth {
  state: MachineHealthState;
  /** The machine as the machine list reports it; undefined until the list arrives. */
  machine: MachineState | undefined;
  reload: (refreshStorage?: boolean) => Promise<void>;
}

/**
 * One machine's health for the Resources page, through the machine link for a
 * linked machine and the same path (`local`) for this one. It paints the
 * snapshot first and fills the rest as each read settles, reads again every
 * minute and when that machine reports a change, and skips reads while the
 * machine list says it is offline.
 */
export function useMachineHealth(machineId: string): UseMachineHealth {
  const [state, setState] = useState<MachineHealthState>(() => {
    const last = lastRead.get(machineId);
    return last ? { status: 'ready', data: last } : { status: 'loading' };
  });
  const [machines, setMachines] = useState<MachineState[] | null>(null);
  const machine = machines?.find(item => item.id === machineId);
  const offline = machine?.status === 'offline';
  const current = useRef(machineId);
  current.current = machineId;
  const offlineNow = useRef(offline);
  offlineNow.current = offline;

  useEffect(() => {
    let live = true;
    void window.electronAPI.machines.list().then(list => { if (live) setMachines(list); }).catch(() => undefined);
    const off = window.electronAPI.machines.onEvent(event => { if (event.type === 'machines') setMachines(event.machines); });
    return () => { live = false; off(); };
  }, []);

  const reload = useCallback(async (refreshStorage = false) => {
    const id = machineId;
    const show = (data: MachineHealthData) => {
      lastRead.set(id, data);
      if (current.current === id && !offlineNow.current) setState({ status: 'ready', data });
    };
    const rest = readRest(id, refreshStorage);
    try {
      const snapshot = await readHealthSnapshot(id);
      const last = lastRead.get(id);
      show({
        inventory: null, finished: [], relief: { idle: { paneIds: [], memoryMB: 0 }, leftBehind: [] }, history: [],
        ...last, snapshot, readAt: Date.now(), pending: true,
      });
    } catch (error) {
      if (current.current === id && !offlineNow.current) setState({ status: 'problem', problem: healthReadProblem(error), last: lastRead.get(id) ?? null });
      return;
    }
    let left = rest.length;
    await Promise.all(rest.map(answer => answer.then(patch => {
      left -= 1;
      const last = lastRead.get(id);
      if (last) show({ ...last, ...patch, pending: left > 0 });
    })));
  }, [machineId]);

  useEffect(() => {
    const last = lastRead.get(machineId) ?? null;
    if (offline) {
      setState({ status: 'problem', problem: { kind: 'offline', message: 'Offline' }, last });
      return;
    }
    setState(last ? { status: 'ready', data: last } : { status: 'loading' });
    void reload();
    const poll = setInterval(() => { void reload(); }, HEALTH_POLL_MS);
    const off = window.electronAPI.machines.onEvent(event => {
      if (event.type === 'resync' && event.machineId === machineId) void reload();
      if (event.type !== 'event' || event.machineId !== machineId) return;
      if (event.channel === MACHINE_HEALTH_CHANGED_EVENT || event.channel === MACHINE_HEALTH_INVENTORY_CHANGED_EVENT) void reload();
    });
    return () => { clearInterval(poll); off(); };
  }, [machineId, reload, offline]);

  return { state, machine, reload };
}
