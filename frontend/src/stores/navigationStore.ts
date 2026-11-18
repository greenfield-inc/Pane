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
 * value there also requires a branch in `SessionView` and a way in from the
 * sidebar: an entry in both sidebar components (`Sidebar` compact rail and
 * `ProjectSessionList` tree), or for Resources, its icon in the sidebar's top bar.
 */
export type ActiveView = PaneNavigationView;

interface NavigationState {
  activeView: ActiveView;
  activeProjectId: number | null;

  // Sidebar collapse
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;

  /**
   * A side region spread across the main area (P4, VS Code's maximized
   * panel). The main area keeps its size underneath, so nothing in it refits.
   */
  maximizedRegion: 'sidebar' | 'right-panel' | null;
  setMaximizedRegion: (region: 'sidebar' | 'right-panel' | null) => void;

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
  navigateToSessions: () => void;
  navigateToPaneChat: () => void;
  /** Resources for a machine (`local` or a linked machine's id); the header switcher changes it. */
  navigateToResources: (machineId?: string) => void;
  resourcesMachineId: string | null;
  navigateToMissionControl: () => void;
  navigateToSsh: () => void;
  navigateToLoops: () => void;
  navigateToProfiles: () => void;
  /** Autopilot spans every Session, so it clears the project scope. */
  navigateToAutopilot: () => void;
  /**
   * Opens Approvals (the `notify` view), on `itemId` when given. The first entry remembers the
   * view and Pane you left (`returnPaneId`), which `leaveApprovals` hands back.
   */
  navigateToNotify: (options?: { itemId?: string; returnPaneId?: string | null }) => void;
  /** The item selected in the Approvals queue. */
  selectedApprovalId: string | null;
  selectApproval: (itemId: string | null) => void;
  approvalsReturn: ApprovalsReturn | null;
  /** Leaves Approvals for the view it was opened from, and says which Pane was active there. */
  leaveApprovals: () => ApprovalsReturn;
  /**
   * Opens To-dos (D-409): the list, or the page of to-do `number` when given. The first entry
   * remembers the view and Pane you left (`returnPaneId`), which `leaveTodos` hands back.
   */
  navigateToTodos: (options?: TodosNavigationOptions) => void;
  /** The to-do whose page To-dos shows; null shows the list. */
  selectedTodoNumber: number | null;
  selectTodo: (number: number | null) => void;
  todosReturn: ApprovalsReturn | null;
  /** Leaves To-dos for the view it was opened from, and says which Pane was active there. */
  leaveTodos: () => ApprovalsReturn;
}

export interface TodosNavigationOptions {
  /** Opens this to-do's page; null opens the list; absent keeps what was showing. */
  number?: number | null;
  returnPaneId?: string | null;
}

export interface ApprovalsReturn {
  view: ActiveView;
  projectId: number | null;
  paneId: string | null;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  activeView: 'sessions',
  activeProjectId: null,

  sidebarCollapsed: localStorage.getItem('pane-sidebar-collapsed') === 'true',
  setSidebarCollapsed: (collapsed) => {
    localStorage.setItem('pane-sidebar-collapsed', String(collapsed));
    set((state) => ({
      sidebarCollapsed: collapsed,
      maximizedRegion: collapsed && state.maximizedRegion === 'sidebar' ? null : state.maximizedRegion,
    }));
  },
  toggleSidebarCollapsed: () => set((state) => {
    const next = !state.sidebarCollapsed;
    localStorage.setItem('pane-sidebar-collapsed', String(next));
    return { sidebarCollapsed: next, maximizedRegion: next && state.maximizedRegion === 'sidebar' ? null : state.maximizedRegion };
  }),

  maximizedRegion: null,
  setMaximizedRegion: (region) => set({ maximizedRegion: region }),

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

  // Resources spans every project and can show another machine, so it clears the project scope.
  resourcesMachineId: null,
  navigateToResources: (machineId?: string) => set(state => ({
    activeView: 'resources',
    activeProjectId: null,
    resourcesMachineId: machineId ?? state.resourcesMachineId ?? 'local',
  })),

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

  // Profiles span every project, like Loops.
  navigateToProfiles: () => set({
    activeView: 'profiles',
    activeProjectId: null
  }),

  navigateToAutopilot: () => set({
    activeView: 'autopilot',
    activeProjectId: null
  }),

  // Approvals lists what waits on you from every project.
  navigateToNotify: (options) => {
    const state = get();
    const approvalsReturn = state.activeView === 'notify'
      ? state.approvalsReturn
      : { view: state.activeView, projectId: state.activeProjectId, paneId: options?.returnPaneId ?? null };
    set({
      activeView: 'notify',
      activeProjectId: null,
      approvalsReturn,
      selectedApprovalId: options?.itemId ?? state.selectedApprovalId,
    });
  },
  selectedApprovalId: null,
  selectApproval: (itemId) => set({ selectedApprovalId: itemId }),
  approvalsReturn: null,
  leaveApprovals: () => {
    const back = get().approvalsReturn ?? { view: 'sessions', projectId: null, paneId: null };
    set({ activeView: back.view === 'notify' ? 'sessions' : back.view, activeProjectId: back.projectId, approvalsReturn: null });
    return back;
  },

  // To-dos lists every to-do on every machine, so it clears the project scope.
  navigateToTodos: (options) => {
    const state = get();
    const todosReturn = state.activeView === 'todos'
      ? state.todosReturn
      : { view: state.activeView, projectId: state.activeProjectId, paneId: options?.returnPaneId ?? null };
    set({
      activeView: 'todos',
      activeProjectId: null,
      todosReturn,
      selectedTodoNumber: options?.number === undefined ? state.selectedTodoNumber : options.number,
    });
  },
  selectedTodoNumber: null,
  selectTodo: (number) => set({ selectedTodoNumber: number }),
  todosReturn: null,
  leaveTodos: () => {
    const back = get().todosReturn ?? { view: 'sessions', projectId: null, paneId: null };
    set({ activeView: back.view === 'todos' ? 'sessions' : back.view, activeProjectId: back.projectId, todosReturn: null });
    return back;
  },
}));
