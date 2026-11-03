import { create } from 'zustand';
import type { MachineRef } from '../utils/allMachinesTree';

/** The machine agents run on now (this computer or a connected host), as the sidebar lists it. */
export interface ActiveMachine extends MachineRef { local: boolean }

export const useActiveMachineStore = create<{ machine: ActiveMachine | null; set: (machine: ActiveMachine | null) => void }>(set => ({
  machine: null,
  set: machine => set({ machine }),
}));
