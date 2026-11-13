import path from 'path';
import { AGENT_REGISTRY_URL, CONFIGURED_AGENT_IDS, agentConfig, configuredAgent } from '../../../../shared/agents';
import type { ChatAgentEntry } from '../../../../shared/types/chatTab';
import { getAppDirectory } from '../../utils/appDirectory';
import { findExecutableInPath } from '../../utils/shellPath';
import { AgentRegistry } from './agentRegistry';

let registry: AgentRegistry | undefined;

/** Registry ids a configured agent covers (its config `chat.registryIds`): Settings > Agents never lists them. */
const covered = new Set(CONFIGURED_AGENT_IDS.flatMap(id => configuredAgent(id).chat?.registryIds ?? []));

/** This host's ACP Registry agents, under Pane's app directory. */
export function getAgentRegistry(): AgentRegistry {
  registry ??= new AgentRegistry({ root: path.join(getAppDirectory(), 'agent-registry'), url: AGENT_REGISTRY_URL, hidden: () => covered, findExecutable: findExecutableInPath });
  return registry;
}

/** Installed registry agents as catalog entries; capabilities join from the catalog's cache once one has started. */
export function registryCatalogEntries(): ChatAgentEntry[] {
  return getAgentRegistry().installed().map(record => {
    const entry: ChatAgentEntry = {
      id: record.id, label: record.name, icon: record.id, iconUrl: record.iconUrl, source: 'registry', installed: true, version: record.version,
      fullAccess: 'pane', switchFromTerminal: { ok: false, reason: `${record.name} has no terminal tab in Pane.` },
    };
    if (record.description) entry.description = record.description;
    return entry;
  });
}

/** An agent's name: its config label, an installed registry agent's own name, or its id. */
export function chatAgentName(agent: string): string {
  return agentConfig(agent)?.label ?? getAgentRegistry().installedRecord(agent)?.name ?? agent;
}
