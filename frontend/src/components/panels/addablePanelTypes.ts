import { PANEL_CAPABILITIES, type ToolPanel, type ToolPanelType } from '../../../../shared/types/panels';

/**
 * The panel types a person can add to a tab strip: no permanent panels, logs
 * (scripts create them), editors (opening files does), the "+" picker itself,
 * or a second copy of a singleton.
 */
export function addablePanelTypes(
  panels: readonly ToolPanel[],
  context: 'project' | 'worktree',
  isRemoteClient: boolean,
): ToolPanelType[] {
  // SAFETY: The value comes from the adjacent finite domain definition.
  return (Object.keys(PANEL_CAPABILITIES) as ToolPanelType[]).filter(type => {
    const capabilities = PANEL_CAPABILITIES[type];
    if (type === 'notes' && isRemoteClient) return false;
    if (context === 'project' && !capabilities.canAppearInProjects) return false;
    if (context === 'worktree' && !capabilities.canAppearInWorktrees) return false;
    if (capabilities.permanent) return false;
    if (type === 'logs' || type === 'editor' || type === 'new-tab') return false;
    if (capabilities.singleton) return !panels.some(panel => panel.type === type);
    return true;
  });
}
