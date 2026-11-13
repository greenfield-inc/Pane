import type { ChatAgentEntry } from '../../../shared/types/chatTab';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';

/**
 * Whether a terminal tab can switch to chat, from the host's catalog entry for the agent it runs.
 * Undefined for a tab that runs no agent the catalog lists, such as a plain shell.
 */
export function terminalChatSwitch(panel: ToolPanel | undefined, agents: readonly ChatAgentEntry[] | undefined): ChatAgentEntry['switchFromTerminal'] | undefined {
  // SAFETY: terminal panels persist TerminalPanelState as their custom state.
  const agent = panel?.type === 'terminal' ? (panel.state.customState as TerminalPanelState | undefined)?.agentType : undefined;
  return agent ? agents?.find(entry => entry.id === agent)?.switchFromTerminal : undefined;
}
