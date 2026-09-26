import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';

/** Only a plain shell belongs in the dock; launched tools stay in working tabs. */
export function getDockTerminalPanel(panels: readonly ToolPanel[]): ToolPanel | undefined {
  return panels.find(panel => {
    if (panel.type !== 'terminal') return false;
    // SAFETY: The terminal discriminator determines the custom-state shape.
    const state = panel.state.customState as TerminalPanelState | undefined;
    // initialCommand is available before the process reports its agent metadata.
    return !state?.initialCommand?.trim() && !state?.isCliPanel && !state?.agentType;
  });
}
