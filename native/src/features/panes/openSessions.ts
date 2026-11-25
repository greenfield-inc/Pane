import { create } from 'zustand';

import { hostIdHash } from '@/auth/hosts';
import type { SavedStateFiles } from '@/daemon/savedState';

const NONE: readonly string[] = [];

interface OpenSessionsState {
  /** The Sessions whose Panes show, by machine id. Every other Session is collapsed. */
  open: Readonly<Record<string, readonly string[]>>;
  /** Reads what the phone kept for `machineIds`, and deletes every other machine's. */
  restore(machineIds: readonly string[]): void;
  toggle(machineId: string, sessionId: string): void;
  /** Forgets the Sessions a machine no longer has: `sessionIds` is its fresh list. */
  keepSessions(machineId: string, sessionIds: readonly string[]): void;
  /** Forgets a machine that is removed, signed out or paired again under a new id. */
  forget(machineId: string): void;
}

/** Which Sessions are open on each machine, kept on the phone in one file per machine. */
export function createOpenSessions(files: SavedStateFiles, options: { saves(machineId: string): boolean }) {
  return create<OpenSessionsState>((set, get) => {
    const change = (machineId: string, sessionIds: readonly string[]) => {
      set(state => ({ open: { ...state.open, [machineId]: sessionIds } }));
      if (!options.saves(machineId)) return;
      if (sessionIds.length === 0) files.remove(fileName(machineId));
      else files.write(fileName(machineId), JSON.stringify(sessionIds));
    };
    return {
      open: {},
      restore: machineIds => {
        const kept = new Set(machineIds.map(fileName));
        for (const name of files.list()) if (!kept.has(name)) files.remove(name);
        set({ open: Object.fromEntries(machineIds.map(id => [id, parseIds(files.read(fileName(id)))])) });
      },
      toggle: (machineId, sessionId) => {
        const open = get().open[machineId] ?? NONE;
        change(machineId, open.includes(sessionId) ? open.filter(id => id !== sessionId) : [...open, sessionId]);
      },
      keepSessions: (machineId, sessionIds) => {
        const open = get().open[machineId] ?? NONE;
        const kept = open.filter(id => sessionIds.includes(id));
        if (kept.length < open.length) change(machineId, kept);
      },
      forget: machineId => change(machineId, NONE),
    };
  });
}

const fileName = (machineId: string) => `${hostIdHash(machineId)}.json`;

function parseIds(text: string | null): readonly string[] {
  try {
    const saved: unknown = JSON.parse(text ?? '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : NONE;
  } catch {
    return NONE;
  }
}
