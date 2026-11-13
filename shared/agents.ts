import { AGENTS_CONFIG } from './types/generatedAgents';
import { boundary } from './validation/boundaryDecoder';

/**
 * Pane's agents config (contracts/runpane/contract.json `agents`), read by main, the
 * renderer, the phone and runpane alike. Code asks it about an agent by id; it never
 * names one. Agents from the ACP Registry have no entry and reach clients through the
 * host's agent catalog instead.
 */

/** An agent with a config entry: a terminal agent, and a first-class chat agent when it has `chat`. */
export type ConfiguredAgentId = keyof typeof AGENTS_CONFIG.entries;

export interface AgentChatConfig {
  args?: readonly string[];
  adapter?: { package: string; executableEnv: string; npmShimScript?: string; sessionFolderSettingsMeta?: string };
  minimumVersion: string;
  apiKeyEnv?: readonly string[];
  fullAccess?: { mode?: string; args?: true };
  riskyModes?: readonly string[];
  terminalConversationsLoad: boolean;
  legacyClients?: boolean;
  registryIds?: readonly string[];
}

/** How a CLI opens a saved conversation from the command line. */
export interface AgentSessionConfig {
  flag: string;
  minimumVersion: string;
  idPattern: string;
  /** The flag also creates the conversation, so Pane picks the id and every launch runs the same command. */
  paneChoosesId?: boolean;
  /** Flags with which a command picks its own conversation; Pane runs that command unchanged. */
  selectors?: readonly string[];
}

interface AgentConfigBase {
  title: string;
  label: string;
  icon: string;
  description?: string;
  executables: readonly string[];
  terminal: {
    args: readonly string[];
    fullAccessArgs: readonly string[];
    hotkey: string;
    reportsConversation?: boolean;
    platforms?: readonly string[];
    /** Takes the starting message as an argument; otherwise Pane types it once the agent's input box is idle. */
    promptArgument?: boolean;
    configDir?: string;
    session?: AgentSessionConfig;
  };
  install: { url: string; command: string };
  onboarding?: boolean;
  onboardingPanelId?: string;
}

/** A chat agent always says how to sign in; a terminal-only agent signs in inside its own CLI. */
export type AgentConfig = AgentConfigBase & (
  | { chat: AgentChatConfig; signIn: readonly string[] }
  | { chat?: undefined; signIn?: readonly string[] }
);

const ENTRIES: Readonly<Record<string, AgentConfig>> = AGENTS_CONFIG.entries;

// SAFETY: Object.keys of the generated const object returns exactly its keys, the ConfiguredAgentId union.
const configuredIds = Object.keys(AGENTS_CONFIG.entries) as ConfiguredAgentId[];
export const CONFIGURED_AGENT_IDS: readonly ConfiguredAgentId[] = configuredIds;
export const DEFAULT_AGENT_ID: ConfiguredAgentId = AGENTS_CONFIG.default;
export const AGENT_REGISTRY_URL: string = AGENTS_CONFIG.registryUrl;

export function agentConfig(id: string): AgentConfig | undefined {
  return Object.prototype.hasOwnProperty.call(ENTRIES, id) ? ENTRIES[id] : undefined;
}

export function isConfiguredAgent(id: string | null | undefined): id is ConfiguredAgentId {
  return !!id && agentConfig(id) !== undefined;
}

/** The configured agent `id` names; for types that only hold configured ids. */
export function configuredAgent(id: ConfiguredAgentId): AgentConfig {
  return ENTRIES[id];
}

/** The terminal launch command: the first executable, the full-access flags, then the other args. */
export function agentTerminalCommand(id: ConfiguredAgentId): string {
  const agent = configuredAgent(id);
  return [agent.executables[0], ...agent.terminal.fullAccessArgs, ...agent.terminal.args].join(' ');
}

/** Whether Pane types this agent's starting message into its input box rather than passing it as an argument. */
export function typesStartingMessage(id: string | null | undefined): boolean {
  const config = id ? agentConfig(id) : undefined;
  return config !== undefined && !config.terminal.promptArgument;
}

/** Whether `id` has the form the agent's session flag accepts. */
export function isAgentSessionId(agent: string | null | undefined, id: string | null | undefined): id is string {
  const session = agent ? agentConfig(agent)?.terminal.session : undefined;
  return session !== undefined && id !== undefined && id !== null && new RegExp(session.idPattern, 'u').test(id);
}

/** First-class chat agents: those whose config says how chat starts. */
export function configuredChatAgentIds(): ConfiguredAgentId[] {
  return CONFIGURED_AGENT_IDS.filter(id => configuredAgent(id).chat);
}

/** A short name for any agent id: its config label, or the id itself for one Pane has no entry for. */
export function agentLabel(id: string): string {
  return agentConfig(id)?.label ?? id;
}

/** Session modes in which some configured agent acts without asking. */
export const RISKY_AGENT_MODES: ReadonlySet<string> = new Set(CONFIGURED_AGENT_IDS.flatMap(id => configuredAgent(id).chat?.riskyModes ?? []));

/** Decodes a configured agent id at a boundary. */
export const configuredAgentSchema = boundary.enumeration(...CONFIGURED_AGENT_IDS);
