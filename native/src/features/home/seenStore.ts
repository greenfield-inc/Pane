import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';

import { secureStore } from '@/auth/secureStore';

import { freshCounts, reconcileSeen, type FreshCounts, type SeenMap, type SeenTarget, type WaitingThing } from './seenWaiting';

/** Per device, across machines: thing keys carry their machine. */
const STORAGE_KEY = 'pane.native.seenWaiting';

interface SeenState {
  /** Undefined until loaded from the phone; null when nothing was ever saved. */
  seen: SeenMap | null | undefined;
  things: readonly WaitingThing[];
  complete: ReadonlySet<string>;
  open: ReadonlyArray<{ id: number; target: SeenTarget }>;
  /** Things that were new when Needs you showed them, while it still shows: their rows wear a dot. */
  justSeen: ReadonlySet<string>;
  /** Home's waiting things, and the machines whose lists are all in. */
  publish(things: readonly WaitingThing[], complete: ReadonlySet<string>): void;
  /** A screen showing `target` came into view; the returned function says it left. */
  show(target: SeenTarget): () => void;
}

let nextId = 0;

/** What waits on the person that the phone has shown them: everything else is "new". */
export const useSeenWaiting = create<SeenState>((set, get) => {
  const reconcile = (change: Partial<SeenState>) => {
    const state = { ...get(), ...change };
    if (state.seen === undefined) return set(change);
    const open = state.open.map(entry => entry.target);
    const { seen, marked } = reconcileSeen({ seen: state.seen, things: state.things, complete: state.complete, open, now: Date.now() });
    const justSeen = open.includes('needs') ? (marked.length > 0 ? new Set([...state.justSeen, ...marked]) : state.justSeen) : new Set<string>();
    // The same map keeps its identity, so Home doesn't draw again for nothing.
    const changed = JSON.stringify(seen) !== JSON.stringify(state.seen);
    if (changed && seen !== null) void secureStore.setItem(STORAGE_KEY, JSON.stringify(seen)).catch(() => undefined);
    set({ ...change, seen: changed ? seen : state.seen, justSeen: justSeen.size === 0 && state.justSeen.size === 0 ? state.justSeen : justSeen });
  };
  return {
    seen: undefined,
    things: [],
    complete: new Set(),
    open: [],
    justSeen: new Set(),
    publish: (things, complete) => {
      const state = get();
      // Home draws often; the same things change nothing.
      if (state.seen !== undefined && JSON.stringify([things, [...complete]]) === JSON.stringify([state.things, [...state.complete]])) return;
      reconcile({ things, complete });
    },
    show: target => {
      const id = nextId++;
      reconcile({ open: [...get().open, { id, target }] });
      return () => reconcile({ open: get().open.filter(entry => entry.id !== id) });
    },
  };
});

void secureStore.getItem(STORAGE_KEY).then(saved => {
  const parsed: unknown = saved ? JSON.parse(saved) : null;
  return parsed && typeof parsed === 'object' ? parsed as SeenMap : null;
}).catch(() => null).then(seen => {
  useSeenWaiting.setState({ seen });
  useSeenWaiting.getState().publish(useSeenWaiting.getState().things, useSeenWaiting.getState().complete);
});

/** While this screen is in view, what it shows (a Pane, Session or approval on the current machine) stops being new. */
export function useShowsWaiting(target: SeenTarget | null) {
  const signature = target === null ? null : JSON.stringify(target);
  useFocusEffect(() => {
    if (signature === null) return undefined;
    return useSeenWaiting.getState().show(JSON.parse(signature) as SeenTarget);
  });
}

/** The "+N" counts for what Home last listed. */
export function useFreshCounts(): FreshCounts {
  const things = useSeenWaiting(state => state.things);
  const seen = useSeenWaiting(state => state.seen);
  return freshCounts(things, seen);
}
