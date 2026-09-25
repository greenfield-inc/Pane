import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { ProjectEnvironment, ToolPanel, ToolPanelType } from '../../../shared/types/panels';

type PanelContext = 'project' | 'worktree';

export interface PanelCreateOptions {
  customResume?: CustomCommandResume | null;
  initialCommand?: string;  // Command to run on terminal init
  title?: string;           // Custom panel title
  initialState?: { customState?: unknown };
}

interface PanelTabPresentation {
  title?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export type PanelTabPresentationResolver = (panel: ToolPanel) => PanelTabPresentation | undefined;

export interface PanelTabBarProps {
  panels: ToolPanel[];
  activePanel?: ToolPanel;
  onPanelSelect: (panel: ToolPanel) => void;
  onPanelClose: (panel: ToolPanel) => void;
  onPanelCreate: (type: ToolPanelType, options?: PanelCreateOptions) => void;
  onShowExplorer: () => void;
  projectEnvironment?: ProjectEnvironment;
  context?: PanelContext;  // Optional context to filter available panels
  onToggleDetailPanel?: () => void;
  detailPanelVisible?: boolean;
  detailPanelToggleDisabled?: boolean;
  detailPanelToggleDisabledReason?: string;

  // --- Optional split tab group integration ---
  /** Panels in layout order for the primary group (overrides internal sort). */
  primaryGroupPanels?: ToolPanel[];
  /** Active panel id for the primary group (overrides activePanel check). */
  primaryGroupActivePanelId?: string | null;
  /** Whether the primary group is the focused group (gates shortcut hints). */
  primaryGroupFocused?: boolean;
  /**
   * When the pane is split, working tabs live in the group strips and the
   * top bar shows only the primary group's permanent tabs (passed via
   * primaryGroupPanels). Disables shortcut hints since the bar then shows a
   * subset and the 1-9 indexes would be wrong.
   */
  tabsInGroups?: boolean;
  /** Called when a drag starts on a tab. */
  onDragStart?: (panelId: string) => void;
  /** Called when a drag ends. */
  onDragEnd?: () => void;
  /** Called when a tab is dropped onto the strip. */
  onStripDrop?: (panelId: string, insertIndex: number) => void;
  /** Whether a tab drag is currently in progress. */
  isTabDragging?: boolean;
  /** The panel id being dragged. */
  draggedPanelId?: string | null;
  /** Optional per-panel title/disabled presentation override. */
  getPanelTabPresentation?: PanelTabPresentationResolver;
}

export interface PanelContainerProps {
  panel: ToolPanel;
  isActive: boolean;
  isMainRepo?: boolean;
  autoFocus?: boolean;
}

export interface TerminalPanelProps {
  panel: ToolPanel;
  isActive: boolean;
  autoFocus?: boolean;
}
