import { useMemo } from 'react';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { isAllMachinesOn, machineViews, useAllMachinesStore } from '../../stores/allMachinesStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { buildAllMachinesTree } from '../../utils/allMachinesTree';
import { sidebarSessionKeys } from './approvalGroups';

const NONE: readonly string[] = [];

/**
 * The Sessions the left sidebar shows, as `<machine id>:<Session id>` keys, top first: the All
 * machines arrangement while that's on, otherwise the app's machine's saved Session order. It
 * follows a drag in the sidebar as it happens. Worked out only while `enabled` (Sidebar order is
 * the chosen grouping), so other groupings don't rebuild the All machines tree on every snapshot.
 */
export function useSidebarSessionOrder(enabled: boolean): readonly string[] {
  const allMachines = useAllMachinesStore(isAllMachinesOn);
  const machines = useAllMachinesStore((state) => state.machines);
  const snapshots = useAllMachinesStore((state) => state.snapshots);
  const entries = useAllMachinesStore((state) => state.entries);
  const arrangement = useAllMachinesStore((state) => state.layout.sessions);
  const sessions = useOrchestrationSessionStore((state) => state.sessions);
  return useMemo(() => {
    if (!enabled) return NONE;
    if (allMachines) {
      const tree = buildAllMachinesTree(machineViews({ machines, snapshots, entries }), { sessions: arrangement, panes: {} });
      return tree.sessions.map((row) => row.key);
    }
    return sidebarSessionKeys(sessions, entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  }, [enabled, allMachines, machines, snapshots, entries, arrangement, sessions]);
}
