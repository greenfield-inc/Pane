import { create } from 'zustand';
import type { OrchestrationSessionRecord, OrchestrationSessionView } from '../../../../shared/types/orchestrationSession';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';
import type { RemoteProjectWithSessions } from '../runtime/remoteRuntimeAdapter';
import { readRemoteView, rememberRemoteView } from './remoteViewMemory';

/** `unavailable` means the host predates Sessions, so the PWA hides them. */
type RemoteOrchestrationAvailability = 'idle' | 'ready' | 'unavailable' | 'error';

/**
 * Everything here belongs to the connected host. `reset` clears it on a host
 * switch or disconnect; the app refetches it after a reconnect.
 */
interface RemoteHostState {
  /** The saved connection this state belongs to; this client's view memory is kept per host. */
  hostId: string | null;
  projects: RemoteProjectWithSessions[];
  /** The Pane whose panels are on screen. An open Session shows its own workspace Pane. */
  selectedSessionId: string | null;
  selectedPanelId: string | null;
  panelsBySessionId: Record<string, ToolPanel[]>;
  orchestrationSessions: OrchestrationSessionRecord[];
  orchestrationAvailability: RemoteOrchestrationAvailability;
  orchestrationError: string | null;
  /** The open Session, set while its workspace Pane is selected. */
  openOrchestrationSession: OrchestrationSessionView<Session> | null;
  /** Null until the Archived section first opens. */
  archivedProjects: RemoteProjectWithSessions[] | null;
}

interface RemoteSessionState extends RemoteHostState {
  /** Clears the previous host's state; `hostId` names the host about to connect. */
  reset: (hostId?: string | null) => void;
  setProjects: (projects: RemoteProjectWithSessions[]) => void;
  selectSession: (sessionId: string | null) => void;
  openSession: (view: OrchestrationSessionView<Session>) => void;
  setOrchestrationSessions: (sessions: OrchestrationSessionRecord[]) => void;
  setOrchestrationFailure: (availability: 'unavailable' | 'error', error: string | null) => void;
  setArchivedProjects: (projects: RemoteProjectWithSessions[]) => void;
  setPanels: (sessionId: string, panels: ToolPanel[]) => void;
  setSelectedPanel: (panelId: string | null) => void;
  upsertPanel: (panel: ToolPanel) => void;
  removePanel: (sessionId: string, panelId: string) => void;
}

const INITIAL_HOST_STATE: RemoteHostState = {
  hostId: null,
  projects: [],
  selectedSessionId: null,
  selectedPanelId: null,
  panelsBySessionId: {},
  orchestrationSessions: [],
  orchestrationAvailability: 'idle',
  orchestrationError: null,
  openOrchestrationSession: null,
  archivedProjects: null,
};

export const useRemoteSessionStore = create<RemoteSessionState>((set, get) => ({
  ...INITIAL_HOST_STATE,

  reset: (hostId = null) => set({ ...INITIAL_HOST_STATE, hostId }),

  setProjects: (projects) => set((state) => ({
    projects,
    selectedSessionId: state.selectedSessionId ?? findRememberedPaneId(state.hostId, projects) ?? findFirstSessionId(projects),
  })),

  selectSession: (sessionId) => {
    set({
      selectedSessionId: sessionId,
      selectedPanelId: null,
      openOrchestrationSession: null,
    });
    const { hostId } = get();
    if (hostId && sessionId) rememberRemoteView(hostId, { paneId: sessionId, sessionId: null });
  },

  openSession: (view) => {
    set({
      selectedSessionId: view.internalSession.id,
      selectedPanelId: view.panel.id,
      openOrchestrationSession: view,
    });
    const { hostId } = get();
    if (hostId) rememberRemoteView(hostId, { paneId: view.internalSession.id, sessionId: view.session.id, panelId: view.panel.id });
  },

  setOrchestrationSessions: (orchestrationSessions) => set({
    orchestrationSessions,
    orchestrationAvailability: 'ready',
    orchestrationError: null,
  }),

  setOrchestrationFailure: (orchestrationAvailability, orchestrationError) => set({
    orchestrationAvailability,
    orchestrationError,
  }),

  setArchivedProjects: (archivedProjects) => set({ archivedProjects }),

  setPanels: (sessionId, panels) => set((state) => ({
    panelsBySessionId: {
      ...state.panelsBySessionId,
      [sessionId]: panels,
    },
    selectedPanelId: state.selectedPanelId ?? panels[0]?.id ?? null,
  })),

  setSelectedPanel: (panelId) => {
    set({ selectedPanelId: panelId });
    const { hostId, selectedSessionId, openOrchestrationSession } = get();
    if (hostId && selectedSessionId && panelId) {
      rememberRemoteView(hostId, { paneId: selectedSessionId, sessionId: openOrchestrationSession?.session.id ?? null, panelId });
    }
  },

  upsertPanel: (panel) => set((state) => {
    const panels = state.panelsBySessionId[panel.sessionId] ?? [];
    const nextPanels = panels.some(existing => existing.id === panel.id)
      ? panels.map(existing => existing.id === panel.id ? panel : existing)
      : [...panels, panel];

    return {
      panelsBySessionId: {
        ...state.panelsBySessionId,
        [panel.sessionId]: nextPanels,
      },
      // Only a Pane on screen with no tab yet takes the new tab; otherwise nobody moves.
      selectedPanelId: state.selectedPanelId ?? (panel.sessionId === state.selectedSessionId ? panel.id : null),
    };
  }),

  removePanel: (sessionId, panelId) => set((state) => {
    const panels = state.panelsBySessionId[sessionId] ?? [];
    const index = panels.findIndex(panel => panel.id === panelId);
    const remaining = panels.filter(panel => panel.id !== panelId);
    // Closing the shown tab elsewhere moves this client to its neighbour, as closing a browser tab does.
    const neighbour = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null;
    return {
      panelsBySessionId: { ...state.panelsBySessionId, [sessionId]: remaining },
      selectedPanelId: state.selectedPanelId === panelId ? neighbour : state.selectedPanelId,
    };
  }),
}));

export function findFirstSessionId(projects: Array<{ sessions?: Session[] }>): string | null {
  for (const project of projects) {
    const session = project.sessions?.[0];
    if (session) {
      return session.id;
    }
  }
  return null;
}

function findRememberedPaneId(hostId: string | null, projects: Array<{ sessions?: Session[] }>): string | null {
  if (!hostId) return null;
  const { paneId } = readRemoteView(hostId);
  return paneId && projects.some(project => project.sessions?.some(session => session.id === paneId)) ? paneId : null;
}
