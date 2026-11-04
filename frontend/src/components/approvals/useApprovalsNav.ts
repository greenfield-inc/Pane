import { useNavigationStore } from '../../stores/navigationStore';
import { useNotifyStore, waitingCount, waitingElsewhere } from '../../stores/notifyStore';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';

export interface ApprovalsNav {
  /** False while Approvals are off: the sidebar shows no Approvals row. */
  enabled: boolean;
  /** Items waiting on you across every saved machine. */
  count: number;
  /** The Approvals screen is open. */
  open: boolean;
  /** Spoken name: "Approvals, 3 waiting". */
  label: string;
  /** Hover text: where a click goes, and what waits on other machines. */
  title: string;
}

/**
 * What the sidebar's Approvals row shows. A click calls `toggleApprovals`: it opens Approvals,
 * and clicked again returns to the view you left.
 */
export function useApprovalsNav(): ApprovalsNav {
  const enabled = useNotifyStore((state) => state.snapshot?.settings.enabled ?? false);
  const count = useNotifyStore((state) => waitingCount(state.snapshot));
  const open = useNavigationStore((state) => state.activeView === 'notify');
  // The count covers every saved machine; the one-machine sidebar shows only this machine's rows.
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const allMachines = useAllMachinesStore((state) => state.enabled);
  const elsewhere = useNotifyStore((state) => (allMachines ? 0 : waitingElsewhere(state.snapshot, activeMachineId)));
  return {
    enabled,
    count,
    open,
    label: count > 0 ? `Approvals, ${count} waiting` : 'Approvals',
    title: open ? 'Back to where you were' : elsewhere > 0 ? `Approvals · ${elsewhere} waiting on other machines` : 'Approvals',
  };
}
