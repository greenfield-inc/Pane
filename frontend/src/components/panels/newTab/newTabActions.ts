import { createContext, useContext } from 'react';
import type { ProjectEnvironment, ToolPanel, ToolPanelType } from '../../../../../shared/types/panels';
import type { PanelCreateOptions } from '../../../types/panelComponents';

/** What a "New tab" picker can do in the view that hosts it (SessionView). */
export interface NewTabActions {
  projectId?: number;
  projectEnvironment?: ProjectEnvironment;
  /** Replace the picker tab, in its place, with a new panel of the chosen tool. */
  replace: (picker: ToolPanel, type: ToolPanelType, options?: PanelCreateOptions) => Promise<void>;
  /** Show the file explorer and close the picker. */
  showExplorer: (picker: ToolPanel) => void;
}

export const NewTabActionsContext = createContext<NewTabActions | null>(null);

export function useNewTabActions(): NewTabActions | null {
  return useContext(NewTabActionsContext);
}
