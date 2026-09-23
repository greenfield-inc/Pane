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
  load: () => Promise<void>;
  refresh: (options?: { adoptServerSelection?: boolean }) => Promise<void>;
  select: (selector: OrchestrationSessionSelector) => Promise<void>;
  create: (input: OrchestrationSessionCreateInput) => Promise<OrchestrationSessionView<Session>>;
  update: (selector: OrchestrationSessionSelector, input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
}

let loadPromise: Promise<void> | null = null;
let operationGeneration = 0;
let refreshSequence = 0;

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

function applyList(data: OrchestrationSessionListResult): void {
  useOrchestrationSessionStore.setState({
    sessions: data.sessions,
    selectedSessionId: activeSessionIdFromList(data.sessions, data.selectedSessionId),
    availability: 'ready',
    error: null,
  });
}

export const useOrchestrationSessionStore = create<OrchestrationSessionState>((set) => ({
  sessions: [],
  selectedSessionId: undefined,
  availability: 'idle',
  error: null,

  load: async () => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) {
      set({ availability: 'unavailable', error: null });
      return;
    }
    if (loadPromise) return loadPromise;

    const generation = ++operationGeneration;
    set({ availability: 'loading', error: null });
    loadPromise = (async () => {
      try {
        const data = ensureSuccess(await API.orchestrationSessions.list(), 'Failed to load Sessions');
        if (generation === operationGeneration) applyList(data);
      } catch (error) {
        if (generation === operationGeneration) {
          set({
            availability: 'error',
            error: error instanceof Error ? error.message : 'Failed to load Sessions',
          });
        }
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  },

  refresh: async (options) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) return;
    const generation = operationGeneration;
    const sequence = ++refreshSequence;

    try {
      const data = ensureSuccess(await API.orchestrationSessions.list(), 'Failed to refresh Sessions');
      if (generation !== operationGeneration || sequence !== refreshSequence) return;
      set((state) => {
        const selectedSessionId = options?.adoptServerSelection
          ? activeSessionIdFromList(data.sessions, data.selectedSessionId)
          : activeSessionIdFromList(data.sessions, state.selectedSessionId);
        return {
          sessions: data.sessions,
          selectedSessionId,
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

  select: async (selector) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) throw new Error('Sessions are unavailable in this Pane runtime');
    const generation = ++operationGeneration;
    try {
      const data = ensureSuccess(await API.orchestrationSessions.select(selector), 'Failed to select Session');
      if (generation === operationGeneration) applyList(data);
    } catch (error) {
      if (generation === operationGeneration) {
        set({ availability: 'error', error: error instanceof Error ? error.message : 'Failed to select Session' });
      }
      throw error;
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
