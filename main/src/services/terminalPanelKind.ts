import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { getDockTerminalPanel } from '../../../shared/utils/terminalDock';
import { resolveAgentTypeFromCommand } from './agents/agentIdentity';

/**
 * What a terminal panel is for, exported to its shell as `PANE_PANEL_KIND` so shell
 * startup files can tell the bottom dock shell from agent and command tabs.
 */
export type TerminalPanelKind = 'agent' | 'command' | 'dock' | 'shell';

export function resolveTerminalPanelKind(panel: ToolPanel, sessionPanels: readonly ToolPanel[]): TerminalPanelKind {
  // SAFETY: Terminal panels carry TerminalPanelState as their custom state.
  const state = panel.state.customState as TerminalPanelState | undefined;
  const initialCommand = state?.initialCommand?.trim();
  if (state?.isCliPanel || state?.agentType || resolveAgentTypeFromCommand(initialCommand)) {
    return 'agent';
  }
  if (initialCommand) {
    return 'command';
  }
  // The spawning panel's own state is the freshest; it may not be stored yet.
  const panels = sessionPanels.some(candidate => candidate.id === panel.id)
    ? sessionPanels.map(candidate => candidate.id === panel.id ? panel : candidate)
    : [...sessionPanels, panel];
  return getDockTerminalPanel(panels)?.id === panel.id ? 'dock' : 'shell';
}
