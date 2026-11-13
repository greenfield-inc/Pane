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
  /** Whether a program is on this host's PATH. Asynchronous: the catalog is read on every + menu open. */
  onPath: (name: string) => Promise<boolean>;
  /** Agents installed from the ACP Registry (P5), already described. */
  registryAgents?: () => ChatAgentEntry[];
}

/**
 * The agents this host can open as chat tabs, with labels and what each supports, for every
 * client (desktop, web, phone, runpane). Configured agents come from the agents config;
 * capabilities come from each agent's own initialize reply, kept from its last start.
 */
/** How long an installed check stays fresh: long enough that opening menus never searches PATH twice in a row. */
const INSTALLED_FRESH_MS = 30_000;

export class ChatAgentCatalog {
  private cache?: CapabilityCache;
  private installed?: { at: number; ids: Promise<Set<string>> };

  constructor(private readonly options: ChatAgentCatalogOptions) {}

  /** Records what an agent said it can do when a chat tab started it. */
  record(agent: string, response: InitializeResponse): void {
    const agentCapabilities = response.agentCapabilities;
    const entry: CapabilityCache[string] = {
      reopen: agentCapabilities?.loadSession === true,
      list: Boolean(agentCapabilities?.sessionCapabilities?.list),
      images: agentCapabilities?.promptCapabilities?.image === true,
    };
    // An adapter reports its own version, not the CLI's, so only an agent running its own CLI's counts.
    if (response.agentInfo?.version && !agentConfig(agent)?.chat?.adapter) entry.version = response.agentInfo.version;
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

  async entries(): Promise<ChatAgentEntry[]> {
    const installed = await this.installedIds();
    const cache = this.read();
    const configured = configuredChatAgentIds().map(id => {
      const agent = agentConfig(id);
      const chat = agent?.chat;
      if (!agent || !chat) throw new Error(`configuredChatAgentIds returned ${id}, which has no chat config`);
      const refusal = terminalSwitchRefusal(id);
      const entry: ChatAgentEntry = {
        id, label: agent.label, icon: agent.icon, source: 'config',
        installed: installed.has(id),
        fullAccess: chat.fullAccess ? 'agent' : 'pane',
        switchFromTerminal: refusal ? { ok: false, reason: refusal } : { ok: true },
        installUrl: agent.install.url,
      };
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

  /** Configured chat agents whose CLI is on PATH, checked off the main thread and kept briefly. */
  private installedIds(): Promise<Set<string>> {
    const now = Date.now();
    if (this.installed && now - this.installed.at < INSTALLED_FRESH_MS) return this.installed.ids;
    const ids = Promise.all(configuredChatAgentIds().map(async id => {
      const found = await Promise.all((agentConfig(id)?.executables ?? []).map(name => this.options.onPath(name)));
      return found.some(Boolean) ? [id] : [];
    })).then(results => new Set(results.flat()));
    this.installed = { at: now, ids };
    return ids;
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
