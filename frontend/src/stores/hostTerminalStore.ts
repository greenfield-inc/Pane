import { create } from 'zustand';
import type { Session } from '../types/session';
import type { HostTerminalState } from '../../../shared/types/hostTerminal';

interface HostTerminalStoreState {
  /** The active host's terminal, as its daemon last returned it. */
  terminal: HostTerminalState<Session> | null;
  setTerminal: (terminal: HostTerminalState<Session> | null) => void;
}

export const useHostTerminalStore = create<HostTerminalStoreState>((set) => ({
  terminal: null,
  setTerminal: (terminal) => set({ terminal }),
}));
