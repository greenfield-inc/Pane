import { useEffect, useMemo, useState } from 'react';
import type { AutopilotSnapshot } from '../../../../shared/types/autopilot';
import type { MachineState } from '../../../../shared/types/machineConnections';
import { useMachines } from '../../hooks/useMachines';
import { useRemoteRuntimeState } from '../../hooks/useRemoteRuntimeState';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { useConfigStore } from '../../stores/configStore';
import { showActionError } from '../../stores/errorStore';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { useRenderedItems } from '../../stores/autopilotStore';
import { API } from '../../utils/api';
import type { MachineEntry } from '../../utils/machineList';
import { useNow } from '../notify/useNow';
import { cantSeeMachines, notBroughtInCount, offlineSavedMachines } from './autopilotFormat';

/** A machine on Tailscale changes rarely; this keeps "Can't see" honest without a wake-up per second. */
const TAILNET_REFRESH_MS = 60_000;

/** Every saved machine's state, whether or not the sidebar is in All machines. */
function useMachineStates(): MachineState[] {
  const [states, setStates] = useState<MachineState[]>([]);
  useEffect(() => {
    let live = true;
    void window.electronAPI.machines.list()
      .then((machines) => { if (live) setStates(machines); })
      .catch((error) => console.warn('[autopilot] Could not list machines:', error));
    const stop = window.electronAPI.machines.onEvent((event) => { if (event.type === 'machines') setStates(event.machines); });
    return () => { live = false; stop(); };
  }, []);
  return states;
}

/** Add: saves the machine with today's flow, without moving the window off this one; a password goes through its usual prompt. */
function AddMachine({ machine, onAdded }: { machine: MachineEntry; onAdded: () => void }) {
  const [adding, setAdding] = useState(false);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const add = async () => {
    if (machine.action === 'password') {
      useAllMachinesStore.getState().askMachinePassword?.(machine.name);
      return;
    }
    setAdding(true);
    try {
      const saved = await API.remoteDaemon.saveTailnetMachine({ name: machine.name });
      if (!saved.success) throw new Error(saved.error ?? `Pane did not save ${machine.name}.`);
      await fetchConfig().catch(() => undefined);
      onAdded();
    } catch (error) {
      showActionError(`Could not add ${machine.name}`, error);
    } finally {
      setAdding(false);
    }
  };
  // Pane isn't open there (or takes no connections yet): nothing to add until it does.
  const unavailable = machine.action === 'none';
  return (
    <button type="button" disabled={adding || unavailable} title={unavailable ? machine.stateText : `Add ${machine.name} to this machine`} onClick={() => void add()}
      data-testid="autopilot-cant-see-add" className="font-medium text-text-secondary underline hover:text-text-primary disabled:no-underline disabled:opacity-50">
      Add
    </button>
  );
}

/**
 * What Autopilot can't reach and what it hasn't brought in, one quiet line under the walk bar
 * (D-165, J29, J34). With nothing to say it takes no room.
 */
export function AutopilotReach({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const { connectionState } = useRemoteRuntimeState();
  const { machines, refresh } = useMachines({ connectionState, refreshMs: TAILNET_REFRESH_MS });
  const states = useMachineStates();
  const now = useNow();
  const items = useNotifyStore(selectNotifyItems);
  const rendered = useRenderedItems((state) => state.counts);
  const cantSee = useMemo(() => cantSeeMachines(machines), [machines]);
  const offline = offlineSavedMachines(states, machines, now);
  const waiting = notBroughtInCount(items, snapshot.stack, rendered);
  if (cantSee.length === 0 && offline.length === 0 && waiting === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-primary px-4 py-1.5 text-[12px] text-text-tertiary" data-testid="autopilot-reach">
      {waiting > 0 && <span data-testid="autopilot-not-brought-in">{waiting} waiting, not brought in yet</span>}
      {cantSee.map((machine) => (
        <span key={machine.id} className="inline-flex min-w-0 items-center gap-1.5" data-testid="autopilot-cant-see">
          <span className="min-w-0 truncate">Can&rsquo;t see: {machine.name}</span>
          <AddMachine machine={machine} onAdded={() => void refresh()} />
        </span>
      ))}
      {offline.map((machine) => <span key={machine.id} data-testid="autopilot-machine-offline">{machine.name} offline</span>)}
    </div>
  );
}
