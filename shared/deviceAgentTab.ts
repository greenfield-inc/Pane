import { agentLabel } from './agents';
import type { ToolPanel } from './types/panels';
import { boundary, decodeOptionalBoundary } from './validation/boundaryDecoder';

/** The agent tab in the device tab's Pane that screenshots, recordings and log lines go to. */
export interface AgentTab {
  id: string;
  kind: 'chat' | 'terminal';
  /** Its agent's name, such as "Claude Code". */
  agent: string;
}

const agentStateSchema = boundary.object({ agent: boundary.optional(boundary.string), agentType: boundary.optional(boundary.string) });

function asAgentTab(panel: ToolPanel): AgentTab | undefined {
  const custom = decodeOptionalBoundary(panel.state.customState, agentStateSchema);
  if (panel.type === 'chat' && custom?.agent) return { id: panel.id, kind: 'chat', agent: agentLabel(custom.agent) };
  if (panel.type === 'terminal' && custom?.agentType) return { id: panel.id, kind: 'terminal', agent: agentLabel(custom.agentType) };
  return undefined;
}

/** The tab whose agent opened the device; else the Pane's newest chat or agent terminal. */
export function agentTabOf(panels: readonly ToolPanel[], openedBy: string | undefined): AgentTab | undefined {
  const opener = panels.find(panel => panel.id === openedBy);
  const tab = opener && asAgentTab(opener);
  if (tab) return tab;
  for (let index = panels.length - 1; index >= 0; index--) {
    const candidate = asAgentTab(panels[index]);
    if (candidate) return candidate;
  }
  return undefined;
}
