import { create } from 'zustand';
import { API } from '../utils/api';
import type {
  OrchestrationSessionCreateInput,
  OrchestrationSessionListResult,
  OrchestrationSessionRecord,
  OrchestrationSessionSelector,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';

export function isArchivedOrchestrationSession(session: OrchestrationSessionRecord): boolean {
  return session.archived === true;
}

export type OrchestrationSessionAvailability = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

interface OrchestrationSessionState {
  sessions: OrchestrationSessionRecord[];
  selectedSessionId?: string;
  availability: OrchestrationSessionAvailability;
  error: string | null;
  selectionError: string | null;
  selectionRevision: number;
  selectionVisits: Record<string, number>;
  invalidateHost: () => void;
  load: () => Promise<void>;
  refresh: (options?: { adoptServerSelection?: boolean }) => Promise<void>;
  /** This desktop's remembered Session for the current host, preferred over the host's last-used one. */
  preferSelection: (sessionId: string | undefined) => void;
  select: (selector: OrchestrationSessionSelector) => Promise<void>;
  create: (input: OrchestrationSessionCreateInput) => Promise<OrchestrationSessionView<Session>>;
  update: (selector: OrchestrationSessionSelector, input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
}

let loadPromise: Promise<void> | null = null;
let loadSequence = 0;
let operationGeneration = 0;
let refreshSequence = 0;
let pendingSelectionGeneration: number | null = null;
// Each desktop keeps its own selected Session. The host's selectedSessionId is
// the one any client picked last, a starting point when this desktop has none.
let preferredSessionId: string | undefined;

function getOrchestrationApi(): typeof window.electronAPI.orchestrationSessions | undefined {
  return window.electronAPI?.orchestrationSessions;
}

function ensureSuccess<T>(response: { success: boolean; data?: T; error?: string }, fallback: string): T {
  if (!response.success || response.data === undefined) {
    throw new Error(response.error || fallback);
  }
  return response.data;
}

function activeSessionIdFromList(
  sessions: OrchestrationSessionRecord[],
  selectedSessionId: string | undefined,
): string | undefined {
  if (!selectedSessionId) return undefined;
  const selected = sessions.find(session => session.id === selectedSessionId);
  return selected && !isArchivedOrchestrationSession(selected) ? selected.id : undefined;
}

function applyList(data: OrchestrationSessionListResult, ownSelectionId?: string): void {
  useOrchestrationSessionStore.setState({
    sessions: data.sessions,
    selectedSessionId: activeSessionIdFromList(data.sessions, ownSelectionId)
      ?? activeSessionIdFromList(data.sessions, data.selectedSessionId),
    availability: 'ready',
    error: null,
  });
}

export const useOrchestrationSessionStore = create<OrchestrationSessionState>((set, get) => ({
  sessions: [],
  selectedSessionId: undefined,
  availability: 'idle',
  error: null,
  selectionError: null,
  selectionRevision: 0,
  selectionVisits: {},
  invalidateHost: () => {
    operationGeneration += 1;
    refreshSequence += 1;
    pendingSelectionGeneration = null;
    preferredSessionId = undefined;
    loadPromise = null;
    loadSequence += 1;
    set({ sessions: [], selectedSessionId: undefined, availability: 'idle', error: null, selectionError: null, selectionRevision: 0, selectionVisits: {} });
  },

  load: async () => {
    // Mounting the workspace after a click must not start a second initial
    // list load that supersedes the already-published selection intent.
    if (get().availability === 'ready' || pendingSelectionGeneration !== null) return;
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) {
      set({ availability: 'unavailable', error: null });
      return;
    }
    if (loadPromise) return loadPromise;

    const generation = ++operationGeneration;
    const sequence = ++loadSequence;
    set({ availability: 'loading', error: null });
    const loading = (async () => {
      // Assign the shared promise before even a synchronous transport failure.
      await Promise.resolve();
      try {
        const data = ensureSuccess(await API.orchestrationSessions.list(), 'Failed to load Sessions');
        if (generation === operationGeneration) applyList(data, preferredSessionId);
      } catch (error) {
        if (generation === operationGeneration) {
          set({
            availability: 'error',
            error: error instanceof Error ? error.message : 'Failed to load Sessions',
          });
        }
      } finally {
        if (sequence === loadSequence) loadPromise = null;
      }
    })();
    loadPromise = loading;
    return loadPromise;
  },

  refresh: async (options) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) return;
    const generation = operationGeneration;
    const sequence = ++refreshSequence;
    const mayAdoptSelection = pendingSelectionGeneration === null;

    try {
      const data = ensureSuccess(await API.orchestrationSessions.list(), 'Failed to refresh Sessions');
      if (generation !== operationGeneration || sequence !== refreshSequence) return;
      set((state) => {
        // Adopting starts from this desktop's own choice and falls back to the
        // host's last-used Session only when it has none.
        const selectedSessionId = options?.adoptServerSelection && mayAdoptSelection
          ? activeSessionIdFromList(data.sessions, state.selectedSessionId)
            ?? activeSessionIdFromList(data.sessions, preferredSessionId)
            ?? activeSessionIdFromList(data.sessions, data.selectedSessionId)
          : activeSessionIdFromList(data.sessions, state.selectedSessionId);
        return {
          sessions: data.sessions,
          selectedSessionId,
          selectionVisits: selectedSessionId && selectedSessionId !== state.selectedSessionId
            ? { ...state.selectionVisits, [selectedSessionId]: (state.selectionVisits[selectedSessionId] ?? 0) + 1 }
            : state.selectionVisits,
          selectionError: selectedSessionId !== state.selectedSessionId ? null : state.selectionError,
          availability: state.availability === 'idle' ? 'ready' : state.availability,
          error: null,
        };
      });
    } catch (error) {
      if (generation !== operationGeneration || sequence !== refreshSequence) return;
      set((state) => ({
        error: error instanceof Error ? error.message : 'Failed to refresh Sessions',
        availability: state.availability === 'idle' ? 'error' : state.availability,
      }));
    }
  },

  preferSelection: (sessionId) => {
    preferredSessionId = sessionId;
    // A list that loaded before the memory was read still shows the host's pick.
    const state = get();
    const remembered = activeSessionIdFromList(state.sessions, sessionId);
    if (remembered && state.availability === 'ready' && pendingSelectionGeneration === null
      && state.selectedSessionId !== remembered) {
      set({ selectedSessionId: remembered, selectionError: null });
    }
  },

  select: async (selector) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) throw new Error('Sessions are unavailable in this Pane runtime');
    const generation = ++operationGeneration;
    pendingSelectionGeneration = generation;
    set({ selectionRevision: get().selectionRevision + 1, selectionError: null });
    const intended = get().sessions.find(session => session.id === selector.sessionId || session.name === selector.name);
    if (intended && !isArchivedOrchestrationSession(intended)) {
      set(state => ({ selectedSessionId: intended.id, availability: 'ready', error: null, selectionError: null,
        selectionVisits: { ...state.selectionVisits, [intended.id]: (state.selectionVisits[intended.id] ?? 0) + 1 } }));
    }
    try {
      const data = ensureSuccess(await API.orchestrationSessions.select(selector), 'Failed to select Session');
      if (generation === operationGeneration) {
        refreshSequence += 1;
        applyList(data, intended?.id);
      }
    } catch (error) {
      if (generation === operationGeneration) {
        const message = error instanceof Error ? error.message : 'Failed to select Session';
        set({ availability: 'error', error: message, selectionError: message });
        throw error;
      }
    } finally {
      if (pendingSelectionGeneration === generation) pendingSelectionGeneration = null;
    }
  },

  create: async (input) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) throw new Error('Sessions are unavailable in this Pane runtime');
    const generation = ++operationGeneration;
    const view = ensureSuccess(await API.orchestrationSessions.create(input), 'Failed to create Session');
    if (generation !== operationGeneration) return view;
    set((state) => ({
      sessions: [...state.sessions.filter(session => session.id !== view.session.id), view.session],
      selectedSessionId: view.session.id,
      availability: 'ready',
      error: null,
    }));
    return view;
  },

  update: async (selector, input) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) throw new Error('Sessions are unavailable in this Pane runtime');
    const generation = ++operationGeneration;
    const record = ensureSuccess(await API.orchestrationSessions.update(selector, input), 'Failed to update Session');
    if (generation !== operationGeneration) return record;
    set((state) => ({
      sessions: state.sessions.map(session => session.id === record.id ? record : session),
      selectedSessionId: state.selectedSessionId === record.id && isArchivedOrchestrationSession(record)
        ? undefined
        : state.selectedSessionId,
      error: null,
    }));
    return record;
  },
}));
