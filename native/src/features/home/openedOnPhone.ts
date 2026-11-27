import { create } from 'zustand';

import { keepMachineFiles, machineFileName as fileName, type SavedStateFiles } from '@/daemon/savedState';

/** Recent lists ten rows; a few more leave room for Panes that were archived since. */
const KEEP = 30;

type Opened = Readonly<Record<string, number>>;
const NONE: Opened = {};

interface OpenedOnPhoneState {
  /** Epoch ms this phone last opened each Pane (a Session's chat Pane too), by machine id, then Pane id. */
  opened: Readonly<Record<string, Opened>>;
  /** Reads what the phone kept for `machineIds`, and deletes every other machine's. */
  restore(machineIds: readonly string[]): void;
  record(machineId: string, paneId: string, at?: number): void;
  /** Forgets a machine that is removed, signed out or paired again under a new id. */
  forget(machineId: string): void;
}

/** When this phone last opened each Pane, kept on the phone in one file per machine: Home's Recent for hosts that don't report it. */
export function createOpenedOnPhone(files: SavedStateFiles, options: { saves(machineId: string): boolean }) {
  return create<OpenedOnPhoneState>((set, get) => {
    const change = (machineId: string, opened: Opened) => {
      set(state => ({ opened: { ...state.opened, [machineId]: opened } }));
      if (!options.saves(machineId)) return;
      if (Object.keys(opened).length === 0) files.remove(fileName(machineId));
      else files.write(fileName(machineId), JSON.stringify(opened));
    };
    return {
      opened: {},
      restore: machineIds => {
        keepMachineFiles(files, machineIds);
        set({ opened: Object.fromEntries(machineIds.map(id => [id, parseOpened(files.read(fileName(id)))])) });
      },
      record: (machineId, paneId, at = Date.now()) => {
        const entries = Object.entries({ ...get().opened[machineId], [paneId]: at });
        change(machineId, Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, KEEP)));
      },
      forget: machineId => change(machineId, NONE),
    };
  });
}

function parseOpened(text: string | null): Opened {
  try {
    const saved: unknown = JSON.parse(text ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return NONE;
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return NONE;
  }
}
