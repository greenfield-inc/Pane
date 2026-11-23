import { useAllMachinesStore } from '../stores/allMachinesStore';
import { openOnMachine, type MachineTarget } from './machineRowActions';

/** How long a newly paired cloud machine may take to reach the machine menu. */
const LISTED_DEADLINE_MS = 15_000;

/**
 * Opens the new cloud Session. The machine menu lists the VM only after main's config push, and the
 * switch restores the VM's own last-shown Session, so once the window is on the VM it opens the new
 * one again, in place.
 */
export async function openNewCloudSession(machineId: string, target: MachineTarget): Promise<void> {
  await until(() => useAllMachinesStore.getState().entries.some((entry) => entry.id === machineId));
  await openOnMachine(machineId, target);
  await until(() => useAllMachinesStore.getState().entries.some((entry) => entry.id === machineId && entry.active));
  await openOnMachine(machineId, target);
}

/** Resolves once `ready` holds for the machine menu, or after a while regardless. */
function until(ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { stop(); resolve(); }, LISTED_DEADLINE_MS);
    const stop = useAllMachinesStore.subscribe(() => {
      if (!ready()) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}
