import { create } from 'zustand';
import type { Session } from '../types/session';
import type { HostTerminalState } from '../../../shared/types/hostTerminal';

interface HostTerminalStoreState {
  /** The terminal as its host's daemon last returned it. */
  terminal: HostTerminalState<Session> | null;
  /** Which host it is on: the saved profile id, or null for this computer. */
  hostId: string | null;
  setTerminal: (terminal: HostTerminalState<Session> | null, hostId: string | null) => void;
}

export const useHostTerminalStore = create<HostTerminalStoreState>((set) => ({
  terminal: null,
  hostId: null,
  setTerminal: (terminal, hostId) => set({ terminal, hostId }),
}));
