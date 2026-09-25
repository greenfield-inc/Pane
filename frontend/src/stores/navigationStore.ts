import { create } from 'zustand';

export type SidebarNavigationScope = 'repositories' | 'pinned' | 'orchestration';

// Tracks which project ids have already been seen so registerProjectIds only
// auto-expands genuinely new projects (preserves user-collapsed state)
let knownProjectIds = new Set<number>();
let hasRegisteredInitialProjectIds = false;

const toProjectIdArray = (projectIds: Set<number>): number[] =>
  Array.from(projectIds).sort((a, b) => a - b);

/**
 * Pane has no router — this enum is the whole navigation model. Adding a value
 * here also requires a branch in `SessionView` and an entry in *both* sidebar
 * components (`Sidebar` compact rail and `ProjectSessionList` expanded tree).
 */
export type ActiveView = 'sessions' | 'project' | 'pane-chat';

interface NavigationState {
  activeView: ActiveView;
  activeProjectId: number | null;

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
  toggleProjectExpanded: (projectId: number) => number[];
  expandProject: (projectId: number) => number[] | null;
  registerProjectIds: (projectIds: number[]) => number[] | null;

  // Last sidebar section used to enter the active pane. Cmd/Ctrl+Arrow uses
  // this to keep cycling within Pinned after a pinned-row click.
  sidebarNavigationScope: SidebarNavigationScope;
  setSidebarNavigationScope: (scope: SidebarNavigationScope) => void;

  // Actions
  setActiveView: (view: ActiveView) => void;
  setActiveProjectId: (projectId: number | null) => void;
  navigateToProject: (projectId: number) => void;
  navigateToSessions: () => void;
  navigateToPaneChat: () => void;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  activeView: 'sessions',
  activeProjectId: null,

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

  setActiveView: (view) => set({ activeView: view }),

  setActiveProjectId: (projectId) => set({ activeProjectId: projectId }),

  navigateToProject: (projectId) => set({
    activeView: 'project',
    activeProjectId: projectId
  }),

  navigateToSessions: () => set({
    activeView: 'sessions',
    activeProjectId: null
  }),

  navigateToPaneChat: () => set({
    activeView: 'pane-chat',
    activeProjectId: null
  }),

}));
