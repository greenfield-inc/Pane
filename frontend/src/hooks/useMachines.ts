import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { API } from '../utils/api';
import { useConfigStore } from '../stores/configStore';
import { buildMachineList, machineOsFromPlatform, type MachineEntry, type MachineOs } from '../utils/machineList';
import type { TailnetMachineList } from '../../../shared/types/workspaceAccess';
import type { RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';

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

// Main does not serialize client transitions, so one switch at a time across the
// sidebar and Settings, which each hold their own copy of this hook.
const useSwitching = create<{ id: string | null }>(() => ({ id: null }));

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Every machine agents can run on (this computer, saved hosts, and Tailscale machines,
 * connected before or not), plus the one action that switches to or connects any of them.
 */
export function useMachines({ connectionState, refreshMs, wrapConnect }: UseMachinesOptions) {
  const profiles = useConfigStore((state) => state.config?.remoteDaemon?.client.profiles);
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
    } catch (cause) {
      if (mounted.current) setListError(errorText(cause, 'Could not list your machines.'));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
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

  const machines = useMemo(
    () => buildMachineList({ connectionState, profiles: profiles ?? [], tailnet, localName, localOs }),
    [connectionState, profiles, tailnet, localName, localOs],
  );

  const select = useCallback(async (machine: MachineEntry, password?: string): Promise<MachineSelectOutcome> => {
    if (machine.action === 'none' || useSwitching.getState().id) return { ok: true };
    if (machine.action === 'password' && password === undefined) return { ok: false, needsPassword: true };
    const connect = wrapConnect ?? (<T,>(run: () => Promise<T>) => run());
    const failure = `Could not connect to ${machine.name}.`;
    useSwitching.setState({ id: machine.id });
    try {
      if (machine.kind === 'local') {
        const response = await API.remoteDaemon.updateClientState({ activeProfileId: null, mode: 'local' });
        if (!response.success) return { ok: false, error: response.error ?? `Could not switch back to ${machine.name}.` };
      } else {
        let profileId = machine.profile?.id;
        // A machine never connected, or one asking for its password again, is saved first.
        if (machine.tailnet && (!profileId || password !== undefined)) {
          const saved = await API.remoteDaemon.saveTailnetMachine({ name: machine.tailnet.name, password });
          if (!saved.success || !saved.data) return { ok: false, error: saved.error ?? failure };
          profileId = saved.data.id;
        }
        if (!profileId) return { ok: false, error: failure };
        const targetId = profileId;
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

  return { machines, tailnet, listError, refreshing, refresh, select, switchingId };
}
