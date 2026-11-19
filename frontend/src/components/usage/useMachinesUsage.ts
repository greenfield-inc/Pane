import { useCallback, useEffect, useRef, useState } from 'react';
import type { MachineState } from '../../../../shared/types/machineConnections';
import type { UsageReport, UsageReportRequest } from '../../../../shared/types/usage';
import type { MachineUsage } from './allMachinesUsage';

/** A machine that has not answered by then keeps its last report on screen. */
const READ_TIMEOUT_MS = 15_000;

/** Where a machine's numbers come from. */
export type MachineUsageState =
  | { kind: 'live'; readAt: number }
  /** Offline or not answering: its last report, if Pane read one, stays with its time. */
  | { kind: 'stale'; reason: 'offline' | 'error'; message: string | null; readAt: number | null };

/**
 * The last report read per machine and view (range and provider, not its timestamps), so an
 * offline machine still shows its numbers when the page opens again.
 */
const lastRead = new Map<string, { report: UsageReport; readAt: number }>();

const readKey = (machineId: string, viewKey: string) => `${machineId}\n${viewKey}`;

async function readReport(machineId: string, request: UsageReportRequest): Promise<UsageReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('It did not answer in time.')), READ_TIMEOUT_MS);
  });
  try {
    const response = (await Promise.race([window.electronAPI.machines.read(machineId, 'usage:get-report', [request]), timeout])).data;
    if (!response?.success || !response.data) throw new Error(response?.error || 'It could not build its usage report.');
    return response.data;
  } finally {
    clearTimeout(timer);
  }
}

export interface MachinesUsage {
  /** Every machine Pane knows, this computer first, as the machine list reports them. */
  machines: MachineState[];
  /** Each machine with a report to show: read now, or its last one. */
  usages: MachineUsage[];
  states: Record<string, MachineUsageState>;
  /** Reads every machine (or the `only` ones) again; resolves once each has answered or timed out. */
  reload: (only?: readonly string[]) => Promise<void>;
  /** True until the first read of every machine settles. */
  loading: boolean;
  /** True while any read is in flight. */
  reading: boolean;
}

/**
 * Usage & Limits for this computer and each linked machine, read through `machines:read` like
 * Resources reads machine health. A machine that is offline or does not answer keeps its last
 * report, marked stale with the time it was read, and is never shown as zero.
 */
export function useMachinesUsage(
  /** Names what is shown (range and provider); reports are kept per machine and view. */
  viewKey: string,
  /** Builds the request when a read starts, so a rolling range ends at that moment. */
  buildRequest: () => UsageReportRequest,
): MachinesUsage {
  const [machines, setMachines] = useState<MachineState[]>([]);
  const [listed, setListed] = useState(false);
  const [states, setStates] = useState<Record<string, MachineUsageState>>({});
  const [loading, setLoading] = useState(true);
  const [inFlight, setInFlight] = useState(0);
  const buildRef = useRef(buildRequest);
  buildRef.current = buildRequest;
  const viewRef = useRef(viewKey);
  viewRef.current = viewKey;
  const machinesRef = useRef(machines);
  machinesRef.current = machines;

  useEffect(() => {
    let live = true;
    void window.electronAPI.machines.list().then(list => { if (live) { setMachines(list); setListed(true); } }).catch(() => { if (live) setListed(true); });
    const off = window.electronAPI.machines.onEvent(event => { if (event.type === 'machines') setMachines(event.machines); });
    return () => { live = false; off(); };
  }, []);

  const reload = useCallback(async (only?: readonly string[]) => {
    const view = viewRef.current;
    const request = buildRef.current();
    // A read that finishes after the view changed keeps its report but leaves the shown state alone.
    const setState = (machineId: string, state: MachineUsageState) => {
      if (viewRef.current === view) setStates(previous => ({ ...previous, [machineId]: state }));
    };
    const targets = machinesRef.current.filter(machine => !only || only.includes(machine.id));
    setInFlight(count => count + 1);
    await Promise.all(targets.map(async machine => {
      const key = readKey(machine.id, view);
      const stale = (reason: 'offline' | 'error', message: string | null): MachineUsageState =>
        ({ kind: 'stale', reason, message, readAt: lastRead.get(key)?.readAt ?? null });
      if (machine.status === 'offline') {
        setState(machine.id, stale('offline', null));
        return;
      }
      try {
        const report = await readReport(machine.id, request);
        const readAt = Date.now();
        lastRead.set(key, { report, readAt });
        setState(machine.id, { kind: 'live', readAt });
      } catch (error) {
        setState(machine.id, stale('error', error instanceof Error ? error.message : String(error)));
      }
    }));
    setInFlight(count => count - 1);
  }, []);

  // A new view reads every machine; otherwise only machines that appeared or changed status are read.
  const machineKey = machines.map(machine => `${machine.id}:${machine.status}`).join(',');
  const readFor = useRef<{ view: string | null; statuses: Map<string, MachineState['status']> }>({ view: null, statuses: new Map() });
  useEffect(() => {
    if (!listed) return;
    const last = readFor.current;
    const changed = last.view === viewKey ? machinesRef.current.filter(machine => last.statuses.get(machine.id) !== machine.status).map(machine => machine.id) : undefined;
    readFor.current = { view: viewKey, statuses: new Map(machinesRef.current.map(machine => [machine.id, machine.status])) };
    if (changed?.length === 0) return;
    void reload(changed).finally(() => setLoading(false));
  }, [listed, machineKey, viewKey, reload]);

  const usages: MachineUsage[] = machines.flatMap(machine => {
    const last = lastRead.get(readKey(machine.id, viewKey));
    if (!last) return [];
    return [{ machineId: machine.id, name: machine.label, stale: states[machine.id]?.kind !== 'live', report: last.report, readAt: last.readAt }];
  });
  return { machines, usages, states, reload, loading, reading: inFlight > 0 };
}
