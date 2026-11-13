import type { ChatAgentEntry } from './types/chatTab';
import { agentLabel, configuredAgent, configuredChatAgentIds } from './agents';

/**
 * The chat agents a host from before the catalog runs: those whose config marks them for older
 * clients. Clients use this list when the host answers chat-tab:agents as an unknown channel.
 */
export function olderHostAgents(): ChatAgentEntry[] {
  return configuredChatAgentIds().filter(id => configuredAgent(id).chat?.legacyClients).map(id => {
    const agent = configuredAgent(id);
    return { id, label: agent.label, icon: agent.icon, source: 'config', installed: true, fullAccess: 'agent', switchFromTerminal: { ok: true }, installUrl: agent.install.url };
  });
}

/** The chat agents a new-tab menu offers: installed ones, Pane's own first, then the others in catalog order. None until the catalog is read. */
export function menuChatAgents(entries: readonly ChatAgentEntry[] | undefined): ChatAgentEntry[] {
  const installed = (entries ?? []).filter(entry => entry.installed);
  return [...installed.filter(entry => entry.source === 'config'), ...installed.filter(entry => entry.source !== 'config')];
}

/** An agent's name: its catalog label, else its config label, else the id itself. */
export function chatAgentLabel(entries: readonly ChatAgentEntry[] | undefined, id: string): string {
  return entries?.find(entry => entry.id === id)?.label ?? agentLabel(id);
}
