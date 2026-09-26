import { create } from 'zustand';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';
import type { RemoteProjectWithSessions } from '../runtime/remoteRuntimeAdapter';

interface RemoteSessionState {
  projects: RemoteProjectWithSessions[];
  selectedSessionId: string | null;
  selectedPanelId: string | null;
  panelsBySessionId: Record<string, ToolPanel[]>;
  setProjects: (projects: RemoteProjectWithSessions[]) => void;
  upsertSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  selectSession: (sessionId: string | null) => void;
  setPanels: (sessionId: string, panels: ToolPanel[]) => void;
  setSelectedPanel: (panelId: string | null) => void;
  upsertPanel: (panel: ToolPanel) => void;
  removePanel: (sessionId: string, panelId: string) => void;
  getSelectedSession: () => Session | null;
  getSelectedPanels: () => ToolPanel[];
}

export const useRemoteSessionStore = create<RemoteSessionState>((set, get) => ({
  projects: [],
  selectedSessionId: null,
  selectedPanelId: null,
  panelsBySessionId: {},

  setProjects: (projects) => set((state) => {
    const hasSelection = projects.some(project => project.sessions?.some(session => session.id === state.selectedSessionId));
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
  }),

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

  getSelectedSession: () => {
    const { projects, selectedSessionId } = get();
    if (!selectedSessionId) return null;
    for (const project of projects) {
      const session = project.sessions?.find(candidate => candidate.id === selectedSessionId);
      if (session) return session;
    }
    return null;
  },

  getSelectedPanels: () => {
    const { panelsBySessionId, selectedSessionId } = get();
    return selectedSessionId ? panelsBySessionId[selectedSessionId] ?? [] : [];
  },
}));
