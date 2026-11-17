import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { useAllMachinesStore } from '../stores/allMachinesStore';
import { useConfigStore } from '../stores/configStore';
import { openOnMachine } from './machineRowActions';

/** The id this computer knows the machine `name` by (a saved profile, or All machines' entry), if any. */
export function machineIdNamed(name: string, config: Pick<RemoteDaemonConfig, 'client'> | undefined = useConfigStore.getState().config?.remoteDaemon): string | undefined {
  const lower = name.toLowerCase();
  const profile = config?.client.profiles.find(candidate => candidate.tailnetMachine?.toLowerCase() === lower || candidate.label.toLowerCase() === lower);
  if (profile) return profile.id;
  return useAllMachinesStore.getState().entries.find(entry => entry.name.toLowerCase() === lower)?.id;
}

/**
 * Opens a Session on the machine it moved to (it keeps its id there), switching this window to
 * that machine. False when this computer has no saved connection to it.
 */
export function openSessionOnMachineNamed(machine: string, session: { id: string; name: string }): boolean {
  const id = machineIdNamed(machine);
  if (!id) return false;
  void openOnMachine(id, { kind: 'session', id: session.id, name: session.name });
  return true;
}
