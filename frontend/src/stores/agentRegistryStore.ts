import { create } from 'zustand';
import type { RegistryAgent, RegistryAgentList } from '../../../shared/types/agentRegistry';
import { ipcErrorCode, ipcErrorMessage } from '../utils/ipcErrorMessage';
import { refreshChatAgents, type ChatAgentSource } from './chatAgentsStore';

/** The host calls Settings > Agents makes for the ACP Registry, plus the catalog it refreshes after a change. */
export type AgentRegistryClient = Pick<Window['electronAPI']['chatTab'], 'registry' | 'installAgent' | 'removeAgent'> & ChatAgentSource;

/** What one registry agent's row is doing, and why its last install or removal failed. */
export interface RegistryRowState { busy?: 'install' | 'remove'; error?: string }

export interface AgentRegistryState {
  /** Undefined until the first read answers. */
  list?: RegistryAgentList;
  rows: Record<string, RegistryRowState>;
  /** The binary with no checksum waiting for the person to allow it. */
  confirmUnverified?: RegistryAgent;
}

export const useAgentRegistryStore = create<AgentRegistryState>(() => ({ rows: {} }));

const setRow = (id: string, row: RegistryRowState) =>
  useAgentRegistryStore.setState(state => ({ rows: { ...state.rows, [id]: row } }));

/** Reads the registry; a failed read keeps the last list and says why. */
export async function refreshAgentRegistry(client: AgentRegistryClient): Promise<void> {
  try {
    useAgentRegistryStore.setState({ list: await client.registry(true) });
  } catch (cause) {
    const error = ipcErrorMessage(cause, 'Pane could not read the ACP Registry.');
    useAgentRegistryStore.setState(state => ({ list: { agents: state.list?.agents ?? [], error } }));
  }
}

async function change(client: AgentRegistryClient, agent: RegistryAgent, busy: 'install' | 'remove', run: () => Promise<RegistryAgentList>): Promise<void> {
  setRow(agent.id, { busy });
  try {
    const list = await run();
    useAgentRegistryStore.setState({ list });
    setRow(agent.id, {});
    // The + menu lists installed registry agents from the catalog.
    void refreshChatAgents(client);
  } catch (cause) {
    // The list was out of date: the host found no checksum for this download.
    if (busy === 'install' && ipcErrorCode(cause) === 'AGENT_REGISTRY_UNVERIFIED') {
      setRow(agent.id, {});
      useAgentRegistryStore.setState({ confirmUnverified: agent });
      return;
    }
    setRow(agent.id, { error: ipcErrorMessage(cause, busy === 'install' ? 'Pane could not install this agent.' : 'Pane could not remove this agent.') });
  }
}

/** Installs an agent; a binary with no checksum waits for the person to allow it first. */
export async function installRegistryAgent(client: AgentRegistryClient, agent: RegistryAgent, allowUnverified = false): Promise<void> {
  if (agent.kind === 'binary' && !agent.verified && !allowUnverified) {
    useAgentRegistryStore.setState({ confirmUnverified: agent });
    return;
  }
  useAgentRegistryStore.setState({ confirmUnverified: undefined });
  await change(client, agent, 'install', () => client.installAgent(agent.id, allowUnverified ? { allowUnverified: true } : undefined));
}

export function cancelUnverifiedInstall(): void {
  useAgentRegistryStore.setState({ confirmUnverified: undefined });
}

export async function removeRegistryAgent(client: AgentRegistryClient, agent: RegistryAgent): Promise<void> {
  await change(client, agent, 'remove', () => client.removeAgent(agent.id));
}
