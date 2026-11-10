import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';

/** Whether a tab is a terminal running Claude or Codex, the agents a chat tab can run. */
export function isAgentTerminal(panel: ToolPanel | undefined): panel is ToolPanel {
  // SAFETY: terminal panels persist TerminalPanelState as their custom state.
  const agent = panel?.type === 'terminal' ? (panel.state.customState as TerminalPanelState | undefined)?.agentType : undefined;
  return agent === 'claude' || agent === 'codex';
}
