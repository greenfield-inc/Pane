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
  /**
   * The Session this client had open, read from its memory when connecting.
   * While set, no Pane is selected in its place, so startup cannot overwrite it.
   */
  pendingSessionId: string | null;
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
  /** Null until the first archived load. */
  archivedProjects: RemoteProjectWithSessions[] | null;
}

interface RemoteSessionState extends RemoteHostState {
  /** Clears the previous host's state; `hostId` names the host about to connect. */
  reset: (hostId?: string | null) => void;
  /** Ends a pending Session restore that did not happen, showing a Pane instead. */
  cancelSessionRestore: () => void;
  setProjects: (projects: RemoteProjectWithSessions[]) => void;
  selectSession: (sessionId: string | null) => void;
  /** Opens a Session on this client's remembered tab there, or on its chat with `showChat`. */
  openSession: (view: OrchestrationSessionView<Session>, options?: { showChat?: boolean }) => void;
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
  pendingSessionId: null,
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

  reset: (hostId = null) => set({
    ...INITIAL_HOST_STATE,
    hostId,
    pendingSessionId: hostId ? readRemoteView(hostId).sessionId : null,
  }),

  cancelSessionRestore: () => set((state) => ({
    pendingSessionId: null,
    selectedSessionId: state.selectedSessionId ?? findRememberedPaneId(state.hostId, state.projects) ?? findFirstSessionId(state.projects),
  })),

  setProjects: (projects) => set((state) => ({
    projects,
    selectedSessionId: state.selectedSessionId
      ?? (state.pendingSessionId ? null : findRememberedPaneId(state.hostId, projects) ?? findFirstSessionId(projects)),
  })),

  selectSession: (sessionId) => {
    set({
      selectedSessionId: sessionId,
      selectedPanelId: null,
      openOrchestrationSession: null,
      pendingSessionId: null,
    });
    const { hostId } = get();
    if (hostId && sessionId) rememberRemoteView(hostId, { paneId: sessionId, sessionId: null });
  },

  openSession: (view, options = {}) => {
    const { hostId } = get();
    const paneId = view.internalSession.id;
    const rememberedPanelId = hostId && !options.showChat ? readRemoteView(hostId).panelIdByPaneId[paneId] : undefined;
    set({
      selectedSessionId: paneId,
      // loadPanels checks the remembered tab against the workspace's visible tabs.
      selectedPanelId: rememberedPanelId ?? view.panel.id,
      openOrchestrationSession: view,
      pendingSessionId: null,
    });
    if (hostId) rememberRemoteView(hostId, { paneId, sessionId: view.session.id, panelId: rememberedPanelId ? undefined : view.panel.id });
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
    const { hostId, selectedSessionId, openOrchestrationSession, panelsBySessionId } = get();
    // A tab the phone cannot show stays viewable, but the phone never comes back to it.
    const panel = selectedSessionId ? panelsBySessionId[selectedSessionId]?.find(candidate => candidate.id === panelId) : undefined;
    if (hostId && selectedSessionId && panelId && (!panel || phoneShows(panel))) {
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

  removePanel: (sessionId, panelId) => {
    const state = get();
    const panels = state.panelsBySessionId[sessionId] ?? [];
    set({ panelsBySessionId: { ...state.panelsBySessionId, [sessionId]: panels.filter(panel => panel.id !== panelId) } });
    if (state.selectedPanelId !== panelId) return;
    // Closing the shown tab elsewhere moves this client to its neighbour in its own tab strip, as closing a browser tab does.
    const strip = visibleTabs(state.openOrchestrationSession, sessionId, panels);
    const index = strip.findIndex(panel => panel.id === panelId);
    const remaining = strip.filter(panel => panel.id !== panelId);
    get().setSelectedPanel(remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null);
  },
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

/** Panel types the phone renders; other types open a card pointing to desktop Pane. */
export function phoneShows(panel: ToolPanel): boolean {
  return panel.type === 'terminal' || panel.type === 'browser' || panel.type === 'explorer';
}

/** The tabs a client shows for a Pane: a Session's workspace hides other agents' chats. */
export function visibleTabs(openSession: OrchestrationSessionView<Session> | null, paneId: string, panels: ToolPanel[]): ToolPanel[] {
  return openSession?.internalSession.id === paneId ? sessionWorkspacePanels(openSession, panels) : panels;
}

/** A Session shows its current agent's chat first, then its own tools, like desktop; other agents' chats stay hidden. */
function sessionWorkspacePanels(view: OrchestrationSessionView<Session>, panels: ToolPanel[]): ToolPanel[] {
  const agentPanelIds = new Set(Object.values(view.session.panelIds));
  const agentPanel = panels.find(panel => panel.id === view.panel.id) ?? view.panel;
  return [agentPanel, ...panels.filter(panel => !agentPanelIds.has(panel.id))];
}
