import { useEffect } from 'react';
import { create } from 'zustand';
import type { ChatAgentEntry, ChatTabClient } from '../../../shared/types/chatTab';
import { agentLabel, configuredAgent, configuredChatAgentIds } from '../../../shared/agents';

/** Where the host's agent catalog comes from: desktop's chat-tab IPC, or the PWA's remote adapter. */
export type ChatAgentSource = Pick<ChatTabClient, 'agents'>;

/** The agents the connected host can open as chat tabs (chat-tab:agents); undefined until read once. */
export const useChatAgentsStore = create<{ entries?: ChatAgentEntry[] }>(() => ({}));

let generation = 0;
let loading = false;

/**
 * A host from before the catalog answers chat-tab:agents with an error. It runs the agents
 * whose config marks them for older clients, so the menus offer those.
 */
function olderHostAgents(): ChatAgentEntry[] {
  return configuredChatAgentIds().filter(id => configuredAgent(id).chat?.legacyClients).map(id => {
    const agent = configuredAgent(id);
    return { id, label: agent.label, icon: agent.icon, source: 'config', installed: true, fullAccess: 'agent', switchFromTerminal: { ok: true }, installUrl: agent.install.url };
  });
}

/** Reads the catalog again, such as when the + menu opens; a newer read wins over an older one. */
export async function refreshChatAgents(source: ChatAgentSource): Promise<void> {
  const mine = ++generation;
  loading = true;
  let entries: ChatAgentEntry[];
  try {
    entries = await source.agents();
  } catch (error) {
    console.warn(`[ChatTabs] Could not read the host's chat agents: ${error instanceof Error ? error.message : String(error)}. Offering the agents every Pane host can run.`);
    entries = olderHostAgents();
  } finally {
    if (mine === generation) loading = false;
  }
  if (mine === generation) useChatAgentsStore.setState({ entries });
}

/** The host's catalog, read once when first needed. */
export function useChatAgents(source: ChatAgentSource | undefined): ChatAgentEntry[] | undefined {
  const entries = useChatAgentsStore(state => state.entries);
  useEffect(() => {
    if (source && !useChatAgentsStore.getState().entries && !loading) void refreshChatAgents(source);
  }, [source]);
  return entries;
}

/** The + menu's chat agents: installed ones, Pane's own agents first, then the others in catalog order. */
export function menuChatAgents(entries: readonly ChatAgentEntry[] | undefined): ChatAgentEntry[] {
  const installed = (entries ?? []).filter(entry => entry.installed);
  return [...installed.filter(entry => entry.source === 'config'), ...installed.filter(entry => entry.source !== 'config')];
}

/** An agent's name: its catalog label, else its config label, else the id itself. */
export function chatAgentLabel(entries: readonly ChatAgentEntry[] | undefined, id: string): string {
  return entries?.find(entry => entry.id === id)?.label ?? agentLabel(id);
}
