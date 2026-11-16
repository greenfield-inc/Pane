import { useCallback, useEffect, useRef, useState } from 'react';
import type { CleanupRun, HealthProcess, MachineHealthSnapshot, StorageInventory } from '../../../../shared/types/machineHealth';
import { MACHINE_HEALTH_CHANGED_EVENT, MACHINE_HEALTH_INVENTORY_CHANGED_EVENT } from '../../../../shared/types/machineHealth';
import type { MachineHealthAction, MachineReadChannel } from '../../../../shared/types/machineConnections';
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

export interface MachineHealthData {
  snapshot: MachineHealthSnapshot;
  inventory: StorageInventory | null;
  finished: FinishedPaneRow[];
  relief: { idle: { paneIds: string[]; memoryMB: number }; leftBehind: HealthProcess[] };
  history: CleanupRun[];
  readAt: number;
}

type MachineHealthState =
  | { status: 'loading' }
  | { status: 'ready'; data: MachineHealthData }
  /** Unreachable or too old: the last data read, if any, stays on screen with its age. */
  | { status: 'problem'; problem: HealthReadProblem; last: MachineHealthData | null };

/** The last data read per machine, so an offline machine still shows something. */
const lastRead = new Map<string, MachineHealthData>();

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

async function readAll(machineId: string, refresh: boolean): Promise<MachineHealthData> {
  const [snapshot, inventory, finished, relief, history] = await Promise.all([
    readHealthSnapshot(machineId),
    read<StorageInventory>(machineId, 'resource-monitor:machine-inventory', [{ refresh }]).catch(() => null),
    read<FinishedPaneRow[]>(machineId, 'resource-monitor:machine-finished-panes').catch(() => []),
    read<MachineHealthData['relief']>(machineId, 'resource-monitor:machine-relief').catch(() => ({ idle: { paneIds: [], memoryMB: 0 }, leftBehind: [] })),
    read<CleanupRun[]>(machineId, 'resource-monitor:machine-cleanup-history').catch(() => []),
  ]);
  return { snapshot, inventory, finished, relief, history, readAt: Date.now() };
}

/** Runs a machine health action on a machine (this one is `local`), through that machine's own checks. */
export async function runHealthAction(machineId: string, action: MachineHealthAction, request: JsonObject): Promise<void> {
  await window.electronAPI.machines.run(machineId, { type: 'machine-health', action, request });
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
  reload: (refreshStorage?: boolean) => Promise<void>;
}

/**
 * One machine's health for the Resources page: read on open and when that
 * machine reports a new sample, through the machine link for a linked machine
 * and the same path (`local`) for this one.
 */
export function useMachineHealth(machineId: string): UseMachineHealth {
  const [state, setState] = useState<MachineHealthState>(() => {
    const last = lastRead.get(machineId);
    return last ? { status: 'ready', data: last } : { status: 'loading' };
  });
  const current = useRef(machineId);
  current.current = machineId;

  const reload = useCallback(async (refreshStorage = false) => {
    const id = machineId;
    try {
      const data = await readAll(id, refreshStorage);
      lastRead.set(id, data);
      if (current.current === id) setState({ status: 'ready', data });
    } catch (error) {
      if (current.current === id) setState({ status: 'problem', problem: healthReadProblem(error), last: lastRead.get(id) ?? null });
    }
  }, [machineId]);

  useEffect(() => {
    const last = lastRead.get(machineId);
    setState(last ? { status: 'ready', data: last } : { status: 'loading' });
    void reload();
    return window.electronAPI.machines.onEvent(event => {
      if (event.type === 'resync' && event.machineId === machineId) void reload();
      if (event.type !== 'event' || event.machineId !== machineId) return;
      if (event.channel === MACHINE_HEALTH_CHANGED_EVENT || event.channel === MACHINE_HEALTH_INVENTORY_CHANGED_EVENT) void reload();
    });
  }, [machineId, reload]);

  return { state, reload };
}
