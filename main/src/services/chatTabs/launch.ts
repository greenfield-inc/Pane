import path from 'path';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatAgent, ChatPanelState, ChatTabLaunch } from '../../../../shared/types/chatTab';
import { tokenizeShellCommand } from '../agents/agentIdentity';
import { PaneError } from '../../../../shared/paneError';
import { getAppDirectory } from '../../utils/appDirectory';
import { findExecutableInPath, getShellPath } from '../../utils/shellPath';
import { interactiveTerminalEnv } from '../../utils/inheritedProcessEnv';
import { getGitAttributionEnv } from '../../utils/attribution';
import { getRuntimeConfigManager } from '../../core/runtime';
import { noteContextPath } from '../noteFiles';
import { withRunpaneBinOnPath } from '../runpaneShim';
import { grantPaneMcp, paneMcpChatServer } from '../paneMcpEndpoint';
import { PANE_MCP_PLUGIN_DENY_SETTINGS, PANE_MCP_TOKEN_ENV, PANE_MCP_URL_ENV } from '../paneMcpNames';
import { isStandardCustomResume, type CustomCommandResume } from '../../../../shared/types/customCommandResume';
import { adapterEntry, checkAgentCli } from '../agentChat/adapterSetup';
import { hostCommand, npmShimScript } from '../agentChat/hostCommand';
import { agentConfig, agentLabel, type AgentConfig, type AgentChatConfig } from '../../../../shared/agents';
import { panePortFor } from '../panePort';
import type { ChatTabLauncher, ResolvedLaunch } from './manager';
import { boundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { claudeSessionFolderSettings, isSessionFolderSettings } from '../agents/sessionFolderAccess';
import type { ResolvedProjectEnv } from '../projectEnvVars';
import { sessionGitCeiling } from '../sessionWorkspace';

/** API keys a person may set for chat tabs on this machine, kept in the OS secure store. */
export interface ChatTabSecrets { apiKey(agent: ChatAgent): string | undefined }

/** Agent Farm profiles (package 5): turns a profile and its launch args into a launch. */
export interface ChatProfileResolver { resolve(panel: ToolPanel, state: ChatPanelState, env: ChatAgentEnv): Promise<ResolvedLaunch> }

export interface ChatLaunchContext {
  /** Whether the tab's Pane runs in WSL or on an SSH host, where chat tabs are not offered. */
  unsupportedHost(panel: ToolPanel): string | undefined;
  /** The variables of the project that owns the tab's Pane, for whoever opened the tab. */
  projectEnv(panel: ToolPanel): Promise<ResolvedProjectEnv>;
  /** The tab's `$PANE_SCRATCH_DIR`, created on first use; undefined when its Pane has none. */
  scratchDirectory?(panel: ToolPanel): Promise<string | undefined>;
}

/** The agent process's environment: string values only, rebuilt at every start and never saved. */
export type ChatAgentEnv = Record<string, string>;

/**
 * The same Pane environment a terminal agent tab gets (PANE_*, runpane on PATH,
 * git attribution, the project's variables), so runpane report and Notify work from
 * inside a chat tab. The project's variables override the inherited environment; Pane's own win.
 */
export function chatTabEnv(panel: ToolPanel, state: ChatPanelState, projectEnv: Record<string, string> = {}): ChatAgentEnv {
  const inherited = interactiveTerminalEnv();
  delete inherited.PANE_ORCHESTRATION_SESSION_ID;
  delete inherited.PANE_SESSION_DIR;
  delete inherited[PANE_MCP_URL_ENV];
  delete inherited[PANE_MCP_TOKEN_ENV];
  delete inherited.PANE_SCRATCH_DIR;
  delete inherited.PANE_AUTOPILOT_RUN_ID;
  delete inherited.PANE_AUTOPILOT_DIR;
  const config = getRuntimeConfigManager().getConfig();
  const env = {
    ...inherited,
    ...getGitAttributionEnv(config),
    ...projectEnv,
    PATH: process.platform === 'linux' ? (process.env.PATH ?? '') : getShellPath(),
    LANG: process.env.LANG || 'en_US.UTF-8',
    WORKTREE_PATH: state.cwd,
    PANE_SESSION_ID: panel.sessionId,
    PANE_PANEL_ID: panel.id,
    PANE_PANEL_KIND: 'agent',
    PANE_PORT: String(panePortFor(panel.sessionId)),
    PANE_WORKSPACE_PATH: state.cwd,
    PANE_NOTES_FILE: config.notesEnabled === true ? noteContextPath(path.join(getAppDirectory(), 'notes'), panel.sessionId) : '',
  } satisfies ChatAgentEnv;
  const session: ChatAgentEnv = {};
  if (state.orchestrationSessionId) {
    session.PANE_ORCHESTRATION_SESSION_ID = state.orchestrationSessionId;
    // Git must not find a repository above the Session folder, as in Session terminals.
    session.GIT_CEILING_DIRECTORIES = sessionGitCeiling();
  }
  if (state.sessionFolder) session.PANE_SESSION_DIR = state.sessionFolder;
  // Autopilot's tab: its run folder, for its documents (D-67). Never a Session (D-69).
  if (state.autopilotRunId) { session.PANE_AUTOPILOT_RUN_ID = state.autopilotRunId; session.PANE_AUTOPILOT_DIR = state.cwd; }
  return withRunpaneBinOnPath({ ...env, ...session });
}

/** An agent installed from the ACP Registry: how it starts (P5). Undefined for any other id. */
export interface RegistryAgentLauncher { resolve(agentId: ChatAgent, env: ChatAgentEnv): Promise<{ executable: string; args: string[]; env?: ChatAgentEnv; version: string } | undefined> }

/**
 * Runs an agent's chat from its config entry: the person's own installed CLI, either as an
 * ACP agent itself (`chat.args`) or through Pane's bundled adapter (`chat.adapter`). An agent
 * with no entry is one installed from the ACP Registry.
 */
export class AgentChatLauncher implements ChatTabLauncher {
  constructor(private readonly options: {
    secrets: ChatTabSecrets; context: ChatLaunchContext; profiles?: ChatProfileResolver; registry?: RegistryAgentLauncher;
    /** An agent's CLI on the PATH terminal agent tabs use. */
    findExecutable?: (name: string) => string | null;
  }) {}

  async resolve(panel: ToolPanel, state: ChatPanelState): Promise<ResolvedLaunch> {
    const unsupported = this.options.context.unsupportedHost(panel);
    if (unsupported) throw new PaneError('CHAT_UNSUPPORTED_HOST', unsupported, `Open "${agentLabel(state.agent)} in Terminal" from the + menu instead.`);
    // A Session orchestrator's Pane belongs to no project, as in terminals.
    const project = state.orchestrationSessionId ? { env: {}, warnings: [] } : await this.options.context.projectEnv(panel);
    for (const warning of project.warnings) console.warn(`[ChatTabs] ${panel.id}: ${warning}`);
    const env = chatTabEnv(panel, state, project.env);
    const scratch = await this.options.context.scratchDirectory?.(panel);
    if (scratch) env.PANE_SCRATCH_DIR = scratch;
    const agent = agentConfig(state.agent);
    if (!agent?.chat) return this.registryLaunch(state, env);
    const chat = agent.chat;
    const find = this.options.findExecutable ?? findExecutableInPath;
    const executable = agent.executables.map(name => find(name)).find(Boolean) ?? null;
    if (!executable) {
      throw new PaneError('CHAT_AGENT_NOT_INSTALLED', `${agent.title} is not installed on this machine, or not on its PATH.`, `Install it with \`${agent.install.command}\`, then press Retry.`);
    }
    // Chat tabs always run the person's installed, unmodified CLI.
    if (chat.adapter) env[chat.adapter.executableEnv] = npmShimScript(executable, chat.adapter.npmShimScript) ?? executable;
    // The owner's key is a Pane secret: a tab a teammate opened signs in on its own.
    const key = panel.metadata?.teammate ? undefined : this.options.secrets.apiKey(state.agent);
    if (key) for (const name of chat.apiKeyEnv ?? []) env[name] = key;
    if (state.launch.kind === 'profile') {
      if (!this.options.profiles) throw new PaneError('CHAT_PROFILE_UNSUPPORTED', 'This Pane cannot start Agent Farm profiles in chat tabs yet.', 'Start the profile in a terminal tab.');
      return this.options.profiles.resolve(panel, state, env);
    }
    // The CLI is checked in the folder and environment it will run in (#1236).
    await checkAgentCli(state.agent, executable, { cwd: state.cwd, env });
    const launch: ResolvedLaunch = { command: chatCommand(agent, chat, executable, state, env) };
    // Pane's tools over HTTP, for an agent that puts a session server in place of its user-level `pane`. The
    // token goes only into the agent's environment: the request names it as a variable (paneMcpChatServer).
    const paneMcp = chat.paneMcpHttp ? grantPaneMcp({ panelId: panel.id, env: { ...env }, cwd: state.cwd, agentLabel: agent.label }) : undefined;
    if (paneMcp) {
      Object.assign(launch.command.env, paneMcp);
      launch.mcpServers = [paneMcpChatServer()];
    }
    if (!chat.adapter) launch.ownCli = true;
    Object.assign(launch, fullAccessLaunch(chat, state.launch));
    const meta = withPaneMcpPluginDenied(sessionFolderMeta(state), paneMcp ? chat.adapter?.sessionFolderSettingsMeta : undefined);
    if (meta) launch.meta = meta;
    return launch;
  }

  private async registryLaunch(state: ChatPanelState, env: ChatAgentEnv): Promise<ResolvedLaunch> {
    if (state.launch.kind === 'profile') throw new PaneError('CHAT_PROFILE_UNSUPPORTED', `Agent Farm profiles run Pane's built-in agents, not ${agentLabel(state.agent)}.`, 'Open a new chat tab for the profile.');
    const installed = await this.options.registry?.resolve(state.agent, env);
    if (!installed) throw new PaneError('CHAT_AGENT_NOT_INSTALLED', `${agentLabel(state.agent)} is not installed on this machine.`, 'Install it in Settings > Agents, then press Retry.');
    const command = hostCommand(installed.executable, installed.args);
    const launch: ResolvedLaunch = { command: { executable: command.executable, args: command.args, cwd: state.cwd, env: { ...env, ...installed.env }, windowsVerbatimArguments: command.windowsVerbatimArguments }, ownCli: true, agentVersion: installed.version };
    Object.assign(launch, fullAccessLaunch(undefined, state.launch));
    return launch;
  }
}

/** The agent process: Pane's bundled adapter run by Electron as Node, or the agent's own CLI in ACP mode. */
function chatCommand(agent: AgentConfig, chat: AgentChatConfig, executable: string, state: ChatPanelState, env: ChatAgentEnv): ResolvedLaunch['command'] {
  if (chat.adapter) {
    const entry = adapterEntry(chat.adapter.package);
    if (!entry) throw new PaneError('CHAT_ADAPTER_MISSING', `This Pane build is missing its bundled ${agent.title} chat adapter.`, 'Reinstall Pane from runpane.com. Terminal agent tabs are not affected.');
    return { executable: process.execPath, args: [entry], cwd: state.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  const fullAccessArgs = state.launch.kind === 'agent' && state.launch.fullAccess && chat.fullAccess?.args ? agent.terminal.fullAccessArgs : [];
  const command = hostCommand(executable, [...fullAccessArgs, ...(chat.args ?? [])]);
  return { executable: command.executable, args: command.args, cwd: state.cwd, env, windowsVerbatimArguments: command.windowsVerbatimArguments };
}

/**
 * Full access for a launch (D-16): the agent's own session mode when its config names one,
 * its launch flags (already in the command), or Pane answering each approval with allow once.
 * A saved `mode` (a profile's, or a tab from before full access was its own field) wins.
 */
function fullAccessLaunch(chat: AgentChatConfig | undefined, launch: ChatTabLaunch): Pick<ResolvedLaunch, 'mode' | 'approveOnce'> {
  if (launch.kind !== 'agent') return {};
  if (launch.mode) return { mode: launch.mode };
  if (!launch.fullAccess) return {};
  if (chat?.fullAccess?.mode) return { mode: chat.fullAccess.mode };
  return chat?.fullAccess?.args ? {} : { approveOnce: true };
}

/**
 * A terminal launch command a chat tab can run instead: the plain agent (its full-access
 * flags become the chat's full access) or `agent-farm run <profile> [--arg k=v]`.
 * Anything else (wrappers, other flags) keeps its terminal, where it runs unchanged.
 */
export function chatLaunchFromCommand(command: string | undefined, agent: ChatAgent): ChatTabLaunch | undefined {
  const config = agentConfig(agent);
  const tokens = tokenizeShellCommand(command?.trim() || config?.executables[0] || agent, process.platform);
  if (!tokens?.length) return undefined;
  if (config?.chat && config.executables.includes(tokens[0])) {
    const rest = tokens.slice(1);
    if (rest.some(token => !terminalFlagCarriedOver(config, token))) return undefined;
    if (!rest.some(token => config.terminal.fullAccessArgs.includes(token))) return { kind: 'agent' };
    // An agent whose full access is a session mode keeps that mode, as its chat tabs always have.
    const mode = config.chat.fullAccess?.mode;
    return mode ? { kind: 'agent', mode } : { kind: 'agent', fullAccess: true };
  }
  if (tokens[0] === 'agent-farm' && tokens[1] === 'run' && tokens[2] && !tokens[2].startsWith('-')) {
    const args: Record<string, string> = {};
    for (let index = 3; index < tokens.length; index += 2) {
      const value = tokens[index + 1];
      const separator = value?.indexOf('=') ?? -1;
      if (tokens[index] !== '--arg' || !value || separator <= 0) return undefined;
      args[value.slice(0, separator)] = value.slice(separator + 1);
    }
    return Object.keys(args).length ? { kind: 'profile', profile: tokens[2], args } : { kind: 'profile', profile: tokens[2] };
  }
  return undefined;
}

/** A flag of the agent's own terminal launch that a chat runs the same way: its full-access flags and its other default args. */
function terminalFlagCarriedOver(agent: AgentConfig, token: string): boolean {
  return agent.terminal.fullAccessArgs.includes(token) || agent.terminal.args.includes(token);
}

export interface SessionChatInput {
  agent: string;
  launchCommand?: string;
  customResume?: CustomCommandResume | null;
  runtime?: string;
  resume?: string;
  /** The Session continues a conversation promoted from a terminal. */
  promoted?: boolean;
}

/**
 * How a Session's orchestrator runs with chat tabs on (D-16, D-185): the chat launch, or why
 * it keeps a terminal, in words the Session's overview can show. Agent Farm's standard resume
 * template doesn't count as custom; a chat reopens through ACP without it.
 */
export function sessionChatLaunch(input: SessionChatInput): { launch: ChatTabLaunch } | { terminalReason: string } {
  const { agent } = input;
  if (!agentConfig(agent)?.chat) return { terminalReason: `Chat tabs don't run ${agentLabel(agent)} yet.` };
  if (input.runtime === 'wsl') return { terminalReason: 'Chat tabs don\'t run in WSL.' };
  if (input.resume || input.promoted) return { terminalReason: 'This Session continues a terminal conversation.' };
  if (input.customResume && !isStandardCustomResume(input.customResume)) return { terminalReason: 'Its launch settings use a custom resume command, which only a terminal can run.' };
  const command = input.launchCommand?.trim();
  const launch = chatLaunchFromCommand(command, agent);
  return launch ? { launch } : { terminalReason: `A chat can't run its launch command the same way: ${command}.` };
}

/**
 * The chat launch for a terminal agent tab being switched to chat: its own launch when a
 * chat tab can run it, with a `--model` flag carried over as the model setting. Anything a
 * chat tab cannot run faithfully (another flag, a wrapper) comes back as `unsupported`, naming
 * the first such token, so the switch keeps the terminal instead of changing the launch.
 */
export function chatLaunchForTerminal(command: string | undefined, agent: ChatAgent, context: { sessionFolder?: string } = {}): { launch: ChatTabLaunch; settings?: Record<string, string> } | { unsupported: string } {
  if (!command?.trim()) return { launch: { kind: 'agent' } };
  const config = agentConfig(agent);
  const tokens = tokenizeShellCommand(command.trim(), process.platform) ?? [];
  const own = !!config && config.executables.includes(tokens[0] ?? '');
  let model: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (own && token === '--model' && tokens[index + 1]) { model = tokens[index + 1]; index += 1; }
    else if (own && token.startsWith('--model=')) model = token.slice('--model='.length);
    // Pane's own Session folder access for a Session's Pane; the chat gets the same (sessionFolderMeta).
    else if (own && config?.chat?.adapter?.sessionFolderSettingsMeta && token === '--settings' && context.sessionFolder && isSessionFolderSettings(tokens[index + 1] ?? '', context.sessionFolder)) index += 1;
    else rest.push(token);
  }
  const launch = chatLaunchFromCommand(rest.map(quoteToken).join(' '), agent);
  if (!launch) return { unsupported: firstUnsupported(rest, agent) };
  return model ? { launch, settings: { model } } : { launch };
}

/** The first token chatLaunchFromCommand cannot represent, for the switch's refusal. */
function firstUnsupported(tokens: string[], agent: ChatAgent): string {
  const config = agentConfig(agent);
  if (config && config.executables.includes(tokens[0] ?? '')) return tokens.slice(1).find(token => !terminalFlagCarriedOver(config, token)) ?? tokens[0];
  if (tokens[0] === 'agent-farm' && tokens[1] === 'run') {
    for (let index = 3; index < tokens.length; index += 2) if (tokens[index] !== '--arg' || !tokens[index + 1]?.includes('=')) return tokens[index];
  }
  return tokens[0] ?? agent;
}

function quoteToken(token: string): string { return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`; }

/**
 * The chat-tab form of the Session folder access Pane gives an agent in a Session's Pane
 * (sessionFolderAccess.ts): the same settings, sent as `_meta` on session/new and
 * session/load to an adapter whose config accepts them. A Session orchestrator works in
 * its own folder, so it gets none; Windows gets none, as in terminals.
 */
/**
 * Adds the deny for the Claude plugin's own `pane` server to the adapter's session settings, for a
 * chat that reaches Pane's tools over HTTP, so it sees one Pane server. `namespace` is the adapter's
 * settings `_meta` namespace, undefined when the chat has no HTTP grant.
 */
function withPaneMcpPluginDenied(meta: JsonObject | undefined, namespace: string | undefined): JsonObject | undefined {
  if (!namespace) return meta;
  const options = decodeOptionalBoundary(meta?.[namespace], boundary.object({ options: boundary.object({ settings: boundary.jsonObject }) }));
  const settings = options?.options.settings ?? {};
  return { ...meta, [namespace]: { options: { settings: { ...settings, ...PANE_MCP_PLUGIN_DENY_SETTINGS } } } };
}

export function sessionFolderMeta(state: Pick<ChatPanelState, 'agent' | 'cwd' | 'sessionFolder'>, platform: NodeJS.Platform = process.platform): JsonObject | undefined {
  const namespace = agentConfig(state.agent)?.chat?.adapter?.sessionFolderSettingsMeta;
  if (!namespace || platform === 'win32' || !state.sessionFolder || path.resolve(state.sessionFolder) === path.resolve(state.cwd)) return undefined;
  return { [namespace]: { options: { settings: claudeSessionFolderSettings(state.sessionFolder) } } };
}

