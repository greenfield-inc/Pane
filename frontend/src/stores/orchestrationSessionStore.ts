import { isReadOnlyHost } from './readOnlyHostStore';
import { create } from 'zustand';
import { API } from '../utils/api';
import type {
  OrchestrationSessionCreateInput,
  OrchestrationSessionListResult,
  OrchestrationSessionRecord,
  OrchestrationSessionSummary,
  OrchestrationSessionSelector,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';
import { moveWithinOwnPlaces } from '../../../shared/utils/sessionOrder';

export function isArchivedOrchestrationSession(session: Pick<OrchestrationSessionSummary, 'archived'>): boolean {
  return session.archived === true;
}

export type OrchestrationSessionAvailability = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

interface OrchestrationSessionState {
  sessions: OrchestrationSessionSummary[];
  selectedSessionId?: string;
  availability: OrchestrationSessionAvailability;
  error: string | null;
  selectionError: string | null;
  /**
   * Counts this desktop's own selections on the current host: clicks, and
   * landing on the Session it remembered for this host. Zero means what is
   * selected is the host's last-used Session or nothing, which a stored
   * Session layout may override.
   */
  selectionRevision: number;
  selectionVisits: Record<string, number>;
  /** Bumps on every host switch, so host-scoped UI state (such as a pending Undo) can tell hosts apart. */
  hostRevision: number;
  invalidateHost: () => void;
  load: () => Promise<void>;
  refresh: (options?: { adoptServerSelection?: boolean; throwOnError?: boolean }) => Promise<void>;
  /**
   * Remembers the Session to land on once the host switch that follows clears this host's
   * Sessions (T-128); undefined drops it, as a newer press or a cancelled switch does.
   */
  landOn: (sessionId: string | undefined) => void;
  /** This desktop's remembered Session for the current host, preferred over the host's last-used one. */
  preferSelection: (sessionId: string | undefined) => void;
  /**
   * Selects a Session. `automatic` marks a select the person didn't make (the restored layout, or
   * "something must be selected"): it never replaces a landing held through a host switch.
   */
  select: (selector: OrchestrationSessionSelector, options?: { automatic?: boolean }) => Promise<void>;
  /** The host switch's restore ended: a landing it took stays held one more second, then lets go. */
  settleLanding: () => void;
  create: (input: OrchestrationSessionCreateInput) => Promise<OrchestrationSessionView<Session>>;
  update: (selector: OrchestrationSessionSelector, input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
  /**
   * Shows the listed Sessions in this order at once, within the places they hold, and saves it on
   * the host. If the host does not save it, the previous order comes back and the error is thrown.
   */
  reorder: (sessionIds: string[]) => Promise<void>;
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
  sessions: OrchestrationSessionSummary[],
  selectedSessionId: string | undefined,
): string | undefined {
  if (!selectedSessionId) return undefined;
  const selected = sessions.find(session => session.id === selectedSessionId);
  return selected && !isArchivedOrchestrationSession(selected) ? selected.id : undefined;
}

/**
 * Landing on this desktop's remembered Session is its own choice, as much as a
 * click is, so it counts as a selection. Without that, a host switch that
 * restores the remembered Session would let the stored layout's focused tile
 * replace it.
 */
function revisionAfter(state: OrchestrationSessionState, selectedSessionId: string | undefined): number {
  const adoptsRemembered = selectedSessionId !== undefined && selectedSessionId === preferredSessionId
    && selectedSessionId !== state.selectedSessionId;
  return adoptsRemembered ? state.selectionRevision + 1 : state.selectionRevision;
}

/**
 * The Session a press on another machine's row asked for (T-128). It waits through the host
 * switch, which clears the outgoing host's Sessions, and is taken by the first list of the new
 * host that has it: that list selects it as a click would, and any select already in flight
 * (one the restored layout started) is dropped, so the host's own last-used Session never wins.
 */
let landing: { sessionId: string; armed: boolean } | undefined;
/**
 * The Session a landing selected, held against automatic selects until shortly after the restore
 * ends (#1767 review F-12): the restored layout or first-run state otherwise picked the host's own
 * Session (its Onboarding Session on a first open) after the landing. `until` is null while the
 * restore runs.
 */
let heldLanding: { sessionId: string; until: number | null } | undefined;
const LANDING_HOLD_AFTER_RESTORE_MS = 1_000;
/** A host switch's restore is running: a landing taken now is held until it ends. */
let restoring = false;

function landingHolds(sessionId: string | undefined): boolean {
  if (!heldLanding) return false;
  if (heldLanding.until !== null && Date.now() >= heldLanding.until) {
    heldLanding = undefined;
    return false;
  }
  return sessionId !== heldLanding.sessionId;
}

function takeLanding(sessions: OrchestrationSessionSummary[]): string | undefined {
  if (!landing?.armed) return undefined;
  const sessionId = activeSessionIdFromList(sessions, landing.sessionId);
  if (!sessionId) return undefined;
  landing = undefined;
  // Taken after the restore ended (the Session arrived late), it is held for a second from now (review F-3).
  heldLanding = { sessionId, until: restoring ? null : Date.now() + LANDING_HOLD_AFTER_RESTORE_MS };
  operationGeneration += 1;
  pendingSelectionGeneration = null;
  preferredSessionId = sessionId;
  return sessionId;
}

/** The state a landing leaves: the Session selected and counted as this desktop's own choice. */
function landedState(state: OrchestrationSessionState, sessionId: string): Partial<OrchestrationSessionState> {
  return {
    selectedSessionId: sessionId,
    selectionRevision: state.selectionRevision + 1,
    selectionVisits: { ...state.selectionVisits, [sessionId]: (state.selectionVisits[sessionId] ?? 0) + 1 },
    selectionError: null,
  };
}

function applyList(data: OrchestrationSessionListResult<OrchestrationSessionSummary>, ownSelectionId?: string): void {
  useOrchestrationSessionStore.setState((state) => {
    const landed = takeLanding(data.sessions);
    if (landed) return { sessions: data.sessions, availability: 'ready', error: null, ...landedState(state, landed) };
    const selectedSessionId = activeSessionIdFromList(data.sessions, ownSelectionId)
      ?? activeSessionIdFromList(data.sessions, data.selectedSessionId);
    return {
      sessions: data.sessions,
      selectedSessionId,
      selectionRevision: revisionAfter(state, selectedSessionId),
      availability: 'ready',
      error: null,
    };
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
  hostRevision: 0,
  landOn: (sessionId) => {
    landing = sessionId ? { sessionId, armed: false } : undefined;
    heldLanding = undefined;
  },
  settleLanding: () => {
    restoring = false;
    if (heldLanding && heldLanding.until === null) heldLanding.until = Date.now() + LANDING_HOLD_AFTER_RESTORE_MS;
  },
  invalidateHost: () => {
    // The host switch a press started arms its landing; the next host's list takes it.
    if (landing) landing.armed = true;
    heldLanding = undefined;
    restoring = true;
    operationGeneration += 1;
    refreshSequence += 1;
    pendingSelectionGeneration = null;
    preferredSessionId = undefined;
    loadPromise = null;
    loadSequence += 1;
    set(state => ({ sessions: [], selectedSessionId: undefined, availability: 'idle', error: null, selectionError: null, selectionRevision: 0, selectionVisits: {}, hostRevision: state.hostRevision + 1 }));
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
      if (generation !== operationGeneration || sequence !== refreshSequence) {
        if (options?.throwOnError && generation === operationGeneration) throw new Error('Session list changed during restoration; retrying the current view.');
        return;
      }
      set((state) => {
        const landed = takeLanding(data.sessions);
        if (landed) return { sessions: data.sessions, availability: state.availability === 'idle' ? 'ready' : state.availability, error: null, ...landedState(state, landed) };
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
          selectionRevision: revisionAfter(state, selectedSessionId),
          selectionVisits: selectedSessionId && selectedSessionId !== state.selectedSessionId
            ? { ...state.selectionVisits, [selectedSessionId]: (state.selectionVisits[selectedSessionId] ?? 0) + 1 }
            : state.selectionVisits,
          selectionError: selectedSessionId !== state.selectedSessionId ? null : state.selectionError,
          availability: state.availability === 'idle' ? 'ready' : state.availability,
          error: null,
        };
      });
    } catch (error) {
      if (generation !== operationGeneration) return;
      if (sequence !== refreshSequence) {
        if (options?.throwOnError) throw error;
        return;
      }
      set((state) => ({
        error: error instanceof Error ? error.message : 'Failed to refresh Sessions',
        availability: state.availability === 'idle' ? 'error' : state.availability,
      }));
      if (options?.throwOnError) throw error;
    }
  },

  preferSelection: (sessionId) => {
    preferredSessionId = sessionId;
    // A list that loaded before the memory was read still shows the host's pick.
    const state = get();
    const remembered = activeSessionIdFromList(state.sessions, sessionId);
    if (remembered && state.availability === 'ready' && pendingSelectionGeneration === null
      && state.selectedSessionId !== remembered) {
      set({ selectedSessionId: remembered, selectionRevision: revisionAfter(state, remembered), selectionError: null });
    }
  },

  select: async (selector, options) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) throw new Error('Sessions are unavailable in this Pane runtime');
    if (options?.automatic) {
      const id = get().sessions.find(session => session.id === selector.sessionId || session.name === selector.name)?.id ?? selector.sessionId;
      if (landingHolds(id)) return;
    } else {
      // The person chose: the landing has done its job.
      heldLanding = undefined;
    }
    const generation = ++operationGeneration;
    pendingSelectionGeneration = generation;
    set({ selectionRevision: get().selectionRevision + 1, selectionError: null });
    const intended = get().sessions.find(session => session.id === selector.sessionId || session.name === selector.name);
    if (intended && !isArchivedOrchestrationSession(intended)) {
      set(state => ({ selectedSessionId: intended.id, availability: 'ready', error: null, selectionError: null,
        selectionVisits: { ...state.selectionVisits, [intended.id]: (state.selectionVisits[intended.id] ?? 0) + 1 } }));
    }
    try {
      // A read-only host keeps its own last-used Session; this window only shows another one.
      const data = ensureSuccess(await (isReadOnlyHost() ? API.orchestrationSessions.list() : API.orchestrationSessions.select(selector)), 'Failed to select Session');
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
      sessions: [view.session, ...state.sessions.filter(session => session.id !== view.session.id)],
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

  reorder: async (sessionIds) => {
    const orchestrationApi = getOrchestrationApi();
    if (!orchestrationApi) throw new Error('Sessions are unavailable in this Pane runtime');
    const generation = operationGeneration;
    const listed = new Set(sessionIds);
    const previous = get().sessions.flatMap(session => listed.has(session.id) ? [session.id] : []);
    // A list read before this move must not briefly put the old order back.
    refreshSequence += 1;
    set(state => ({ sessions: moveWithinOwnPlaces(state.sessions, sessionIds, session => session.id) }));
    try {
      const data = ensureSuccess(await API.orchestrationSessions.reorder(sessionIds), 'Failed to save the Session order');
      if (generation !== operationGeneration) return;
      refreshSequence += 1;
      set(state => ({ sessions: data.sessions, selectedSessionId: activeSessionIdFromList(data.sessions, state.selectedSessionId) }));
    } catch (error) {
      if (generation === operationGeneration) {
        set(state => ({ sessions: moveWithinOwnPlaces(state.sessions, previous, session => session.id) }));
      }
      throw error;
    }
  },
}));
