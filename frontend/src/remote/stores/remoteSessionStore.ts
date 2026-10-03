import { create } from 'zustand';
import type { OrchestrationSessionRecord, OrchestrationSessionView } from '../../../../shared/types/orchestrationSession';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';
import type { RemoteProjectWithSessions } from '../runtime/remoteRuntimeAdapter';

/** `unavailable` means the host predates Sessions, so the PWA hides them. */
type RemoteOrchestrationAvailability = 'idle' | 'ready' | 'unavailable' | 'error';

/**
 * Everything here belongs to the connected host. `reset` clears it on a host
 * switch or disconnect; the app refetches it after a reconnect.
 */
interface RemoteHostState {
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
  reset: () => void;
  setProjects: (projects: RemoteProjectWithSessions[]) => void;
  upsertSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
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

export const useRemoteSessionStore = create<RemoteSessionState>((set) => ({
  ...INITIAL_HOST_STATE,

  reset: () => set(INITIAL_HOST_STATE),

  setProjects: (projects) => set((state) => {
    const hasSelection = state.openOrchestrationSession?.internalSession.id === state.selectedSessionId || projects.some(project => project.sessions?.some(session => session.id === state.selectedSessionId));
    return {
      projects,
      selectedSessionId: hasSelection ? state.selectedSessionId : null,
      selectedPanelId: hasSelection ? state.selectedPanelId : null,
    };
  }),

  upsertSession: (session) => set((state) => ({
    projects: state.projects.map(project => {
      const sessions = project.sessions ?? [];
      if (project.id !== session.projectId && !sessions.some(existing => existing.id === session.id)) return project;
      return {
        ...project,
        sessions: sessions.some(existing => existing.id === session.id)
          ? sessions.map(existing => existing.id === session.id ? session : existing)
          : [...sessions, session],
      };
    }),
  })),

  removeSession: (sessionId) => set((state) => {
    const panelsBySessionId = { ...state.panelsBySessionId };
    delete panelsBySessionId[sessionId];
    return {
      projects: state.projects.map(project => project.sessions?.some(session => session.id === sessionId)
        ? { ...project, sessions: project.sessions.filter(session => session.id !== sessionId) } : project),
      panelsBySessionId,
      selectedSessionId: state.selectedSessionId === sessionId ? null : state.selectedSessionId,
      selectedPanelId: state.selectedSessionId === sessionId ? null : state.selectedPanelId,
    };
  }),

  selectSession: (sessionId) => set({
    selectedSessionId: sessionId,
    selectedPanelId: null,
    openOrchestrationSession: null,
  }),

  openSession: (view) => set({
    selectedSessionId: view.internalSession.id,
    selectedPanelId: view.panel.id,
    openOrchestrationSession: view,
  }),

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

  setSelectedPanel: (panelId) => set({ selectedPanelId: panelId }),

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
      selectedPanelId: state.selectedPanelId ?? panel.id,
    };
  }),

  removePanel: (sessionId, panelId) => set((state) => ({
    panelsBySessionId: {
      ...state.panelsBySessionId,
      [sessionId]: (state.panelsBySessionId[sessionId] ?? []).filter(panel => panel.id !== panelId),
    },
    selectedPanelId: state.selectedPanelId === panelId ? null : state.selectedPanelId,
  })),
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
