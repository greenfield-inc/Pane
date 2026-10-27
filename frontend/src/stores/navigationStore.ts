import { create } from 'zustand';
import type { PaneNavigationView } from '../../../shared/types/hostNavigation';

export type SidebarNavigationScope = 'repositories' | 'pinned' | 'orchestration';

// Tracks which project ids have already been seen so registerProjectIds only
// auto-expands genuinely new projects (preserves user-collapsed state)
let knownProjectIds = new Set<number>();
let hasRegisteredInitialProjectIds = false;

const toProjectIdArray = (projectIds: Set<number>): number[] =>
  Array.from(projectIds).sort((a, b) => a - b);

/**
 * Pane has no router — this enum is the whole navigation model. It lives in
 * `shared` because per-host navigation memory crosses the IPC boundary; adding a
 * value there also requires a branch in `SessionView` and an entry in *both*
 * sidebar components (`Sidebar` compact rail and `ProjectSessionList` tree).
 */
export type ActiveView = PaneNavigationView;

interface NavigationState {
  activeView: ActiveView;
  activeProjectId: number | null;
  /** The project whose view shows the Start a task card even over its tabs, until a tab is chosen. */
  startTaskProjectId: number | null;

  // Sidebar collapse
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;

  // Immersive mode — all sidebars hide in sync
  immersiveMode: boolean;
  setImmersiveMode: (immersive: boolean) => void;

  // Sidebar project expansion, shared between ProjectSessionList and the
  // always-mounted session hotkeys so mod+1-9 numbering matches the visible list
  expandedProjects: Set<number>;
  hydrateExpandedProjects: (projectIds: number[]) => void;
  // After a host switch: adopt that host's saved expansion and auto-expand none of its existing repositories.
  resetExpandedProjectsForHost: (projectIds: number[]) => void;
  toggleProjectExpanded: (projectId: number) => number[];
  expandProject: (projectId: number) => number[] | null;
  registerProjectIds: (projectIds: number[]) => number[] | null;

  // Sessions whose Pane rows the sidebar shows; every other Session is collapsed.
  // Only the Session's chevron changes it. Kept here so the choice outlives the
  // sidebar remounting between its full and compact layouts.
  expandedSessions: Set<string>;
  hydrateExpandedSessions: (sessionIds: string[]) => void;
  toggleSessionExpanded: (sessionId: string) => string[];

  // Repositories open inside the sidebar's Archived list, kept here for the same reason.
  expandedArchivedProjects: Set<number>;
  hydrateExpandedArchivedProjects: (projectIds: number[]) => void;
  toggleArchivedProjectExpanded: (projectId: number) => number[];

  // Last sidebar section used to enter the active pane. Cmd/Ctrl+Arrow uses
  // this to keep cycling within Pinned after a pinned-row click.
  sidebarNavigationScope: SidebarNavigationScope;
  setSidebarNavigationScope: (scope: SidebarNavigationScope) => void;

  // Actions
  setActiveView: (view: ActiveView) => void;
  setActiveProjectId: (projectId: number | null) => void;
  navigateToProject: (projectId: number) => void;
  navigateToStartTask: (projectId: number) => void;
  clearStartTask: () => void;
  navigateToSessions: () => void;
  navigateToPaneChat: () => void;
  navigateToMissionControl: () => void;
  navigateToSsh: () => void;
  navigateToLoops: () => void;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  activeView: 'sessions',
  activeProjectId: null,
  startTaskProjectId: null,

  sidebarCollapsed: localStorage.getItem('pane-sidebar-collapsed') === 'true',
  setSidebarCollapsed: (collapsed) => {
    localStorage.setItem('pane-sidebar-collapsed', String(collapsed));
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebarCollapsed: () => set((state) => {
    const next = !state.sidebarCollapsed;
    localStorage.setItem('pane-sidebar-collapsed', String(next));
    return { sidebarCollapsed: next };
  }),

  immersiveMode: false,
  setImmersiveMode: (immersive) => set({ immersiveMode: immersive }),

  sidebarNavigationScope: 'repositories',
  setSidebarNavigationScope: (scope) => set({ sidebarNavigationScope: scope }),

  expandedProjects: new Set<number>(),
  hydrateExpandedProjects: (projectIds) => {
    set({ expandedProjects: new Set(projectIds) });
  },
  resetExpandedProjectsForHost: (projectIds) => {
    knownProjectIds = new Set();
    hasRegisteredInitialProjectIds = false;
    set({ expandedProjects: new Set(projectIds) });
  },
  toggleProjectExpanded: (projectId) => {
    const next = new Set(get().expandedProjects);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    set({ expandedProjects: next });
    return toProjectIdArray(next);
  },
  expandProject: (projectId) => {
    const current = get().expandedProjects;
    if (current.has(projectId)) return null;
    const next = new Set(current);
    next.add(projectId);
    set({ expandedProjects: next });
    return toProjectIdArray(next);
  },
  registerProjectIds: (projectIds) => {
    if (!hasRegisteredInitialProjectIds) {
      knownProjectIds = new Set(projectIds);
      hasRegisteredInitialProjectIds = true;
      return null;
    }

    const newIds = projectIds.filter(id => !knownProjectIds.has(id));
    knownProjectIds = new Set(projectIds);
    if (newIds.length === 0) return null;
    const next = new Set(get().expandedProjects);
    newIds.forEach(id => next.add(id));
    set({ expandedProjects: next });
    return toProjectIdArray(next);
  },

  expandedSessions: new Set<string>(),
  hydrateExpandedSessions: (sessionIds) => {
    set({ expandedSessions: new Set(sessionIds) });
  },
  toggleSessionExpanded: (sessionId) => {
    const next = new Set(get().expandedSessions);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    set({ expandedSessions: next });
    return Array.from(next);
  },

  expandedArchivedProjects: new Set<number>(),
  hydrateExpandedArchivedProjects: (projectIds) => {
    set({ expandedArchivedProjects: new Set(projectIds) });
  },
  toggleArchivedProjectExpanded: (projectId) => {
    const next = new Set(get().expandedArchivedProjects);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    set({ expandedArchivedProjects: next });
    return toProjectIdArray(next);
  },

  setActiveView: (view) => set({ activeView: view }),

  setActiveProjectId: (projectId) => set({ activeProjectId: projectId }),

  navigateToProject: (projectId) => set({
    activeView: 'project',
    activeProjectId: projectId,
    startTaskProjectId: null,
  }),

  navigateToStartTask: (projectId) => set({
    activeView: 'project',
    activeProjectId: projectId,
    startTaskProjectId: projectId,
  }),

  clearStartTask: () => set({ startTaskProjectId: null }),

  navigateToSessions: () => set({
    activeView: 'sessions',
    activeProjectId: null
  }),

  navigateToPaneChat: () => set({
    activeView: 'pane-chat',
    activeProjectId: null
  }),

  // Mission Control spans every project, so it clears the project scope.
  navigateToMissionControl: () => set({
    activeView: 'mission-control',
    activeProjectId: null
  }),

  navigateToSsh: () => set({
    activeView: 'ssh',
    activeProjectId: null
  }),

  // Loops span every project, so the page clears the project scope.
  navigateToLoops: () => set({
    activeView: 'loops',
    activeProjectId: null
  }),
}));
