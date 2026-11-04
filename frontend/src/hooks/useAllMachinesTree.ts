import { useMemo } from 'react';
import { machineViews, useAllMachinesStore } from '../stores/allMachinesStore';
import { buildAllMachinesTree } from '../utils/allMachinesTree';

/** Every machine's views, the tree drawn from them, and which machine the app is on. */
export function useAllMachinesTree() {
  const machines = useAllMachinesStore((state) => state.machines);
  const snapshots = useAllMachinesStore((state) => state.snapshots);
  const entries = useAllMachinesStore((state) => state.entries);
  // Re-derives dimming when a machine's offline grace ends.
  const clock = useAllMachinesStore((state) => state.clock);
  return useMemo(() => {
    const views = machineViews({ machines, snapshots, entries });
    return { views, tree: buildAllMachinesTree(views), activeMachineId: entries.find((entry) => entry.active)?.id ?? null };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock only marks time passing
  }, [machines, snapshots, entries, clock]);
}
