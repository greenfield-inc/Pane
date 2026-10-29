import type { TerminalPanelState, ToolPanel } from '../types/panels';

/**
 * The Pane's terminal dock: the first plain shell. Only a plain shell belongs in the
 * dock; launched tools stay in working tabs. The renderer docks it, and runpane marks
 * it `dock: true` and leaves it out of Pane status.
 */
export function getDockTerminalPanel(panels: readonly ToolPanel[]): ToolPanel | undefined {
  return panels.find(panel => {
    if (panel.type !== 'terminal') return false;
    // SAFETY: The terminal discriminator determines the custom-state shape.
    const state = panel.state.customState as TerminalPanelState | undefined;
    // initialCommand is available before the process reports its agent metadata.
    return !state?.initialCommand?.trim() && !state?.isCliPanel && !state?.agentType;
  });
}
