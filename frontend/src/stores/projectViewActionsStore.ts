import { create } from 'zustand';
import type { InspectorTab } from '../components/InspectorTabs';

/**
 * What a Pane view other than a worktree Pane can do in response to the
 * global tab / view hotkeys. SessionView registers the hotkeys once for every
 * view; when the active view is the main repo (ProjectView) or a Session (its
 * focused tile, SessionWorkspacePanels) it routes them here instead of at its
 * own worktree state, so the tab, split, terminal and right-panel keys behave
 * the same everywhere (P3: "Sessions: enable the tab, split and focus keys").
 */
export interface ProjectViewActions {
  toggleDetail: () => void;
  showInspector: (tab: InspectorTab) => void;
  addTerminal: () => void;
  tabCount: () => number;
  selectTab: (index: number) => void;
  cycleTab: (direction: 'next' | 'prev') => void;
  canCloseActiveTab: () => boolean;
  closeActiveTab: () => void;
  /** Split the focused group's active tab out to the right (row) or below (column). */
  canSplit?: () => boolean;
  split?: (direction: 'row' | 'column') => void;
  toggleTerminal?: () => void;
}

interface ProjectViewActionsState {
  /** The main-repo Pane's actions, while it is shown. */
  actions: ProjectViewActions | null;
  setActions: (actions: ProjectViewActions | null) => void;
  /**
   * The focused Session tile's actions. Tiles register in mount order and the
   * newest wins, so a tile shown beside an approval never strands the
   * Sessions view's tile when it goes away.
   */
  sessionActions: ProjectViewActions | null;
  sessionOwners: Array<{ owner: symbol; actions: ProjectViewActions }>;
  setSessionActions: (owner: symbol, actions: ProjectViewActions | null) => void;
}

export const useProjectViewActionsStore = create<ProjectViewActionsState>((set) => ({
  actions: null,
  setActions: (actions) => set({ actions }),
  sessionActions: null,
  sessionOwners: [],
  setSessionActions: (owner, actions) => set((state) => {
    const others = state.sessionOwners.filter(entry => entry.owner !== owner);
    const sessionOwners = actions ? [...others, { owner, actions }] : others;
    return { sessionOwners, sessionActions: sessionOwners[sessionOwners.length - 1]?.actions ?? null };
  }),
}));
