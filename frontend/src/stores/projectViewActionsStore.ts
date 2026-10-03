import { create } from 'zustand';
import type { InspectorTab } from '../components/InspectorTabs';
import type { PanelCreateOptions } from '../types/panelComponents';

/**
 * What a main-repo pane (ProjectView) can do in response to the global tab /
 * view hotkeys. SessionView registers the hotkeys once for every pane; when
 * the active pane is the main repo it routes them here instead of at its own
 * (worktree) state, so ⌘⇧B, ⌘⌥1, ⌘⇧1-9, ⌘A/⌘D and ⌘W behave the same in both.
 */
interface ProjectViewActions {
  toggleDetail: () => void;
  showInspector: (tab: InspectorTab) => void;
  addTerminal: () => void;
  addTerminalWithOptions: (options: PanelCreateOptions) => void;
  tabCount: () => number;
  selectTab: (index: number) => void;
  cycleTab: (direction: 'next' | 'prev') => void;
  canCloseActiveTab: () => boolean;
  closeActiveTab: () => void;
}

interface ProjectViewActionsState {
  actions: ProjectViewActions | null;
  setActions: (actions: ProjectViewActions | null) => void;
}

export const useProjectViewActionsStore = create<ProjectViewActionsState>((set) => ({
  actions: null,
  setActions: (actions) => set({ actions }),
}));
