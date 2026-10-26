import { useEffect } from 'react';
import { create } from 'zustand';
import type { Loop, LoopInput, LoopRun } from '../../../shared/types/loop';
import { API } from '../utils/api';
import { showActionError } from './errorStore';
import { useNavigationStore } from './navigationStore';
import { useOrchestrationSessionStore } from './orchestrationSessionStore';
import { useSessionStore } from './sessionStore';

export interface LoopRunRef {
  loop: Loop;
  run: LoopRun;
}

/** The loop editor: closed, a new loop (`loopId: null`), or an existing one. */
type LoopDrawerState = { loopId: string | null } | null;

interface LoopsState {
  loops: Loop[];
  /** Each run Pane's loop and run, so a Pane can tell it is a loop run. */
  runsBySessionId: ReadonlyMap<string, LoopRunRef>;
  /** The loop the Loops page shows; the first loop when unset or gone. */
  selectedLoopId: string | null;
  drawer: LoopDrawerState;
  refresh: () => Promise<void>;
  /** Saves and returns null, or returns why it was not saved. */
  save: (input: LoopInput) => Promise<string | null>;
  /** Deletes and returns null, or returns why it was not deleted. */
  remove: (id: string) => Promise<string | null>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Starts one run now; the schedule is unchanged. */
  runNow: (id: string) => Promise<void>;
  selectLoop: (id: string) => void;
  openDrawer: (loopId: string | null) => void;
  closeDrawer: () => void;
}

let refreshGeneration = 0;

function indexRuns(loops: Loop[]): Map<string, LoopRunRef> {
  const index = new Map<string, LoopRunRef>();
  for (const loop of loops) {
    for (const run of loop.runs) {
      if (run.sessionId) index.set(run.sessionId, { loop, run });
    }
  }
  return index;
}

export const useLoopsStore = create<LoopsState>((set, get) => ({
  loops: [],
  runsBySessionId: new Map(),
  selectedLoopId: null,
  drawer: null,

  refresh: async () => {
    const generation = ++refreshGeneration;
    const response = await API.loops.list().catch(() => null);
    // A slower answer never overwrites a newer one.
    if (generation !== refreshGeneration || !response?.success || !response.data) return;
    set({ loops: response.data, runsBySessionId: indexRuns(response.data) });
  },

  save: async (input) => {
    try {
      const response = await API.loops.save(input);
      if (!response.success || !response.data) return response.error ?? 'The loop was not saved.';
      set({ selectedLoopId: response.data.id });
      await get().refresh();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'The loop was not saved.';
    }
  },

  remove: async (id) => {
    try {
      const response = await API.loops.remove(id);
      if (!response.success) return response.error ?? 'The loop was not deleted.';
      await get().refresh();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'The loop was not deleted.';
    }
  },

  setEnabled: async (id, enabled) => {
    const action = enabled ? 'resume' : 'pause';
    try {
      const response = await API.loops.setEnabled(id, enabled);
      if (!response.success) showActionError(`Could not ${action} the loop`, response.error);
    } catch (error) {
      showActionError(`Could not ${action} the loop`, error);
    }
    await get().refresh();
  },

  runNow: async (id) => {
    try {
      const response = await API.loops.runNow(id);
      if (!response.success) showActionError('Could not start the run', response.error);
    } catch (error) {
      showActionError('Could not start the run', error);
    }
    await get().refresh();
  },

  selectLoop: (id) => set({ selectedLoopId: id }),
  openDrawer: (loopId) => set({ drawer: { loopId } }),
  closeDrawer: () => set({ drawer: null }),
}));

/** Opens the Loops page, on one loop when given. */
export function navigateToLoops(loopId?: string): void {
  if (loopId) useLoopsStore.getState().selectLoop(loopId);
  void useSessionStore.getState().setActiveSession(null);
  useNavigationStore.getState().navigateToLoops();
}

/** Opens a run's Pane, as a click on its sidebar row does. */
export function openLoopRun(sessionId: string): void {
  const navigation = useNavigationStore.getState();
  navigation.setSidebarNavigationScope('repositories');
  void useSessionStore.getState().setActiveSession(sessionId);
  navigation.navigateToSessions();
}

/** Opens a Session loop's Session, as a pane:// Session link does. */
export function openLoopSession(sessionId: string): void {
  useNavigationStore.getState().navigateToPaneChat();
  void useOrchestrationSessionStore.getState().select({ sessionId }).catch(() => undefined);
}

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Keeps loops current while the sidebar is mounted: on start, whenever main
 * says they changed, when a Pane or project is deleted (a project's loops go
 * with it), when this window starts driving another Pane host, and every
 * minute so "next run" and skipped runs move on.
 */
export function useLoopsRefresh(): void {
  const refresh = useLoopsStore(state => state.refresh);
  useEffect(() => {
    if (!window.electronAPI) return;
    const reread = () => { void refresh(); };
    reread();
    const events = window.electronAPI.events;
    const unsubscribers = [
      events.onLoopsChanged(reread),
      events.onSessionDeleted(reread),
      events.onRemoteDaemonResyncRequested(reread),
      events.onProjectListChanged?.(reread),
    ];
    const timer = window.setInterval(reread, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      for (const unsubscribe of unsubscribers) unsubscribe?.();
    };
  }, [refresh]);
}
