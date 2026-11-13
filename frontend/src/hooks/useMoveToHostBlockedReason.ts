import { useConfigStore } from '../stores/configStore';
import { useAllMachinesStore } from '../stores/allMachinesStore';
import { moveBlockedReason, sessionHostFor, sessionHostForMachine } from '../utils/moveSessionToHost';

/**
 * Why "Move to machine…" can't run, or null when it can: for the host on screen, or with
 * `machine`, for a Session on that machine in All machines.
 */
export function useMoveToHostBlockedReason(machine?: { id: string; name: string }): string | null {
  const remoteDaemon = useConfigStore(state => state.config?.remoteDaemon);
  const status = useAllMachinesStore(state => machine ? state.machines.find(candidate => candidate.id === machine.id)?.status : undefined);
  if (!machine) return moveBlockedReason(sessionHostFor(remoteDaemon));
  return moveBlockedReason(sessionHostForMachine(remoteDaemon, machine.id), { name: machine.name, status });
}
