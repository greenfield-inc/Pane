import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import type { ChatAgentCapabilities, ChatAgentEntry } from '../../../../shared/types/chatTab';
import { agentConfig, configuredChatAgentIds } from '../../../../shared/agents';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { terminalSwitchRefusal } from './switchToChat';

/** What an agent's last initialize reply said it can do, by agent id. */
type CapabilityCache = Record<string, ChatAgentCapabilities & { version?: string }>;
const cacheSchema = boundary.record(boundary.object({ reopen: boundary.boolean, list: boundary.boolean, images: boundary.boolean, version: boundary.optional(boundary.string) }));

export interface ChatAgentCatalogOptions {
  /** Where the capabilities each agent last reported are kept. */
  file: string;
  /** The agent's CLI on this host's PATH, or null. */
  findExecutable: (name: string) => string | null;
  /** Agents installed from the ACP Registry (P5), already described. */
  registryAgents?: () => ChatAgentEntry[];
}

/**
 * The agents this host can open as chat tabs, with labels and what each supports, for every
 * client (desktop, web, phone, runpane). Configured agents come from the agents config;
 * capabilities come from each agent's own initialize reply, kept from its last start.
 */
export class ChatAgentCatalog {
  private cache?: CapabilityCache;

  constructor(private readonly options: ChatAgentCatalogOptions) {}

  /** Records what an agent said it can do when a chat tab started it. */
  record(agent: string, response: InitializeResponse): void {
    const agentCapabilities = response.agentCapabilities;
    const entry: CapabilityCache[string] = {
      reopen: agentCapabilities?.loadSession === true,
      list: Boolean(agentCapabilities?.sessionCapabilities?.list),
      images: agentCapabilities?.promptCapabilities?.image === true,
    };
    if (response.agentInfo?.version) entry.version = response.agentInfo.version;
    const cache = this.read();
    if (JSON.stringify(cache[agent]) === JSON.stringify(entry)) return;
    cache[agent] = entry;
    try {
      mkdirSync(path.dirname(this.options.file), { recursive: true });
      writeFileSync(this.options.file, JSON.stringify(cache));
    } catch (error) {
      console.warn(`[ChatTabs] Could not save what ${agent} supports: ${error instanceof Error ? error.message : String(error)}. Settings shows it after its next start.`);
    }
  }

  entries(): ChatAgentEntry[] {
    const cache = this.read();
    const configured = configuredChatAgentIds().map(id => {
      const agent = agentConfig(id);
      const chat = agent?.chat;
      if (!agent || !chat) throw new Error(`configuredChatAgentIds returned ${id}, which has no chat config`);
      const refusal = terminalSwitchRefusal(id);
      const entry: ChatAgentEntry = {
        id, label: agent.label, icon: agent.icon, source: 'config',
        installed: agent.executables.some(name => this.options.findExecutable(name) !== null),
        fullAccess: chat.fullAccess ? 'agent' : 'pane',
        switchFromTerminal: refusal ? { ok: false, reason: refusal } : { ok: true },
        installUrl: agent.install.url,
      };
      if (agent.description) entry.description = agent.description;
      const known = cache[id];
      if (known) {
        entry.capabilities = { reopen: known.reopen, list: known.list, images: known.images };
        if (known.version) entry.version = known.version;
      }
      return entry;
    });
    const registry = (this.options.registryAgents?.() ?? []).map(entry => {
      const known = cache[entry.id];
      return known && !entry.capabilities ? { ...entry, capabilities: { reopen: known.reopen, list: known.list, images: known.images } } : entry;
    });
    return [...configured, ...registry];
  }

  private read(): CapabilityCache {
    if (this.cache) return this.cache;
    let cache: CapabilityCache = {};
    try { if (existsSync(this.options.file)) cache = decodeOptionalBoundary(JSON.parse(readFileSync(this.options.file, 'utf8')), cacheSchema) ?? {}; }
    catch { cache = {}; }
    this.cache = cache;
    return cache;
  }
}
