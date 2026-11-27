import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { API } from '../utils/api';
import { useConfigStore } from '../stores/configStore';
import { buildMachineList, machineOsFromPlatform, type MachineEntry, type MachineOs } from '../utils/machineList';
import { useConnectionPresence } from './useConnectionPresence';
import { createLatestSwitch } from '../utils/latestSwitch';
import type { TailnetMachineList } from '../../../shared/types/workspaceAccess';
import type { RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';
import type { ComputerRoutesReport } from '../../../shared/types/remoteComputers';
import type { MachineState } from '../../../shared/types/machineConnections';

export type MachineSelectOutcome =
  | { ok: true }
  | { ok: false; needsPassword: true }
  | { ok: false; needsPassword?: false; error: string };

interface UseMachinesOptions {
  connectionState: RemotePaneConnectionState;
  /** Re-list Tailscale machines on this period while mounted; omit to list only on `refresh()`. */
  refreshMs?: number;
  /** Wraps each connect, so Settings can close once its checklist card appears. */
  wrapConnect?: <T>(connect: () => Promise<T>) => Promise<T>;
}

// One switch at a time across the sidebar and Settings, which each hold their own copy of this
// hook. A press during a switch waits and then runs, and a newer press replaces it (T-128, D-6).
const useSwitching = create<{ id: string | null }>(() => ({ id: null }));
// A press for another machine stops the switch still checking an older one, so the newer one starts now (D-6).
const machineSwitches = createLatestSwitch(
  (press: { machineId: string; computerId: string | undefined; job: () => Promise<MachineSelectOutcome> }) => press.job(),
  {
    // Only this sidebar's own switch, to the saved computer it named (review F-4).
    cancel: (running, next) => {
      if (running.computerId && running.machineId !== next.machineId) void API.remoteDaemon.cancelSwitch(running.computerId).catch(() => undefined);
    },
  },
);

/** What a press of a machine row needs: which machine, and whether there is anything to switch. */
export interface MachinePress {
  id: string;
  kind: MachineEntry['kind'];
  action: MachineEntry['action'];
  computerId: string | undefined;
}

/**
 * Queues a press of a machine row (latest wins, D-6). The machine the window is on has nothing to
 * switch, but its press still goes through the queue, so a switch to another machine still dialing
 * stops and the older one never lands (review 1781 R2-SF-1).
 */
export function requestMachinePress(machine: MachinePress, job: () => Promise<MachineSelectOutcome>) {
  const run = machine.action === 'none' ? async (): Promise<MachineSelectOutcome> => ({ ok: true }) : job;
  return machineSwitches.request({ machineId: machine.id, computerId: machine.kind === 'local' ? undefined : machine.computerId, job: run });
}

/** The newest machine switch requested so far: a change means a newer one (review 1781 R4-SF-1). */
export function latestMachineSwitchTicket(): number {
  return machineSwitches.latestTicket();
}

/** An engage the person moved off (T-132): its switch still waiting behind another one never runs. */
export function withdrawMachineSwitch(machineId: string): boolean {
  return machineSwitches.withdraw(press => press.machineId === machineId);
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Every machine agents can run on (this computer, saved computers, and Tailscale machines not
 * saved yet), plus the one action that switches to or connects any of them.
 */
export function useMachines({ connectionState, refreshMs, wrapConnect }: UseMachinesOptions) {
  const computers = useConfigStore((state) => state.config?.remoteDaemon?.client.computers);
  // Each saved computer's live state (online, the route in use), whether or not All machines is on.
  const [machineStates, setMachineStates] = useState<MachineState[]>([]);
  const localMode = connectionState.mode !== 'remote';
  const marks = useConfigStore((state) => state.config?.machineMarks);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const [tailnet, setTailnet] = useState<TailnetMachineList | null>(null);
  const [localName, setLocalName] = useState<string | null>(null);
  const [localOs, setLocalOs] = useState<MachineOs | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const switchingId = useSwitching((state) => state.id);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [list, access] = await Promise.all([
        API.remoteDaemon.listTailnetMachines(),
        API.remoteDaemon.getWorkspaceAccess().catch(() => null),
      ]);
      if (!mounted.current) return;
      if (list.success && list.data) {
        setTailnet(list.data);
        setListError(null);
      } else {
        setListError(list.error ?? 'Could not list your machines.');
      }
      if (access?.success && access.data?.machineName) setLocalName(access.data.machineName);
      else if (localMode) {
        // Without Tailscale, this computer's name is the one it reports to the computers it links with.
        const report: ComputerRoutesReport | null = await window.electronAPI.invoke('computers:routes-report').catch(() => null);
        if (mounted.current && report?.name) setLocalName(report.name);
      }
    } catch (cause) {
      if (mounted.current) setListError(errorText(cause, 'Could not list your machines.'));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [localMode]);

  useEffect(() => {
    let stopped = false;
    const unsubscribe = window.electronAPI.machines.onEvent((event) => {
      if (event.type === 'machines') setMachineStates(event.machines);
    });
    window.electronAPI.machines.list().then((states) => { if (!stopped) setMachineStates(states); }).catch(() => undefined);
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    void window.electronAPI.getPlatform().then((platform) => {
      if (mounted.current) setLocalOs(machineOsFromPlatform(platform));
    }).catch(() => undefined);
    void refresh();
    const timer = refreshMs ? window.setInterval(() => void refresh(), refreshMs) : undefined;
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, refreshMs]);

  // The active machine pulses through the grace window and dims after it, like every other connection dot.
  const { presence: connectionPresence } = useConnectionPresence(connectionState);
  const machines = useMemo(
    () => buildMachineList({ connectionState, computers: computers ?? [], tailnet, localName, localOs, connectionPresence, marks, machineStates }),
    [connectionState, computers, tailnet, localName, localOs, connectionPresence, marks, machineStates],
  );

  const switchTo = useCallback(async (machine: MachineEntry, password?: string): Promise<MachineSelectOutcome> => {
    const connect = wrapConnect ?? (<T,>(run: () => Promise<T>) => run());
    const failure = `Could not connect to ${machine.name}.`;
    useSwitching.setState({ id: machine.id });
    try {
      if (machine.kind === 'local') {
        const response = await API.remoteDaemon.updateClientState({ activeProfileId: null, mode: 'local' });
        if (!response.success) return { ok: false, error: response.error ?? `Could not switch back to ${machine.name}.` };
      } else {
        let computerId = machine.computer?.id;
        // A machine never connected, or one asking for its password again, is saved first.
        if (machine.tailnet && (!computerId || password !== undefined)) {
          const saved = await API.remoteDaemon.saveTailnetMachine({ name: machine.tailnet.name, password });
          if (!saved.success || !saved.data) return { ok: false, error: saved.error ?? failure };
          computerId = saved.data.id;
        }
        if (!computerId) return { ok: false, error: failure };
        const targetId = computerId;
        const switched = await connect(() => API.remoteDaemon.updateClientState({ activeProfileId: targetId, mode: 'remote' }));
        if (!switched.success) return { ok: false, error: switched.error ?? failure };
      }
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: errorText(cause, failure) };
    } finally {
      await fetchConfig().catch(() => undefined);
      useSwitching.setState({ id: null });
      if (mounted.current) void refresh();
    }
  }, [fetchConfig, refresh, wrapConnect]);

  const select = useCallback(async (machine: MachineEntry, password?: string): Promise<MachineSelectOutcome> => {
    if (machine.action === 'password' && password === undefined) return { ok: false, needsPassword: true };
    const press = { id: machine.id, kind: machine.kind, action: machine.action, computerId: machine.computer?.id };
    const result = await requestMachinePress(press, () => switchTo(machine, password));
    // A newer press replaced this one: it says nothing, and the newer one reports for both.
    return result.superseded ? { ok: true } : result.value;
  }, [switchTo]);

  return { machines, tailnet, listError, refreshing, refresh, select, switchingId };
}
