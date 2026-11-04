import { create } from 'zustand';

import { secureStore } from '@/auth/secureStore';

/** Per device: the home filter and New's machine stay as the person left them across relaunches. */
const ALL_KEY = 'pane.native.allMachines';
const LAST_NEW_KEY = 'pane.native.lastNewMachine';

interface MachinePrefsState {
  /** Home shows every saved machine's list instead of the current machine's. */
  all: boolean;
  /** The profile id New last created on; New starts there. */
  lastNew: string | null;
  setAll(all: boolean): void;
  setLastNew(profileId: string): void;
}

export const useMachinePrefs = create<MachinePrefsState>(set => ({
  all: false,
  lastNew: null,
  setAll: all => {
    set({ all });
    void secureStore.setItem(ALL_KEY, all ? '1' : '0').catch(() => undefined);
  },
  setLastNew: lastNew => {
    set({ lastNew });
    void secureStore.setItem(LAST_NEW_KEY, lastNew).catch(() => undefined);
  },
}));

void Promise.all([secureStore.getItem(ALL_KEY), secureStore.getItem(LAST_NEW_KEY)]).then(([all, lastNew]) => {
  useMachinePrefs.setState(state => ({ all: all === null ? state.all : all === '1', lastNew: lastNew ?? state.lastNew }));
}).catch(() => undefined);
