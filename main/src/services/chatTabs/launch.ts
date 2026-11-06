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
import { isStandardCustomResume, type CustomCommandResume } from '../../../../shared/types/customCommandResume';
import { adapterEntry, installAdapter } from '../agentChat/adapterSetup';
import { providerScript } from '../agentChat/hostCommand';
import { panePortFor } from '../panePort';
import type { ChatTabLauncher, ResolvedLaunch } from './manager';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { claudeSessionFolderSettings, isSessionFolderSettings } from '../agents/sessionFolderAccess';

/** API keys a person may set for chat tabs on this machine, kept in the OS secure store. */
export interface ChatTabSecrets { apiKey(agent: ChatAgent): string | undefined }

/** Agent Farm profiles (package 5): turns a profile and its launch args into a launch. */
export interface ChatProfileResolver { resolve(panel: ToolPanel, state: ChatPanelState, env: ChatAgentEnv): Promise<ResolvedLaunch> }

export interface ChatLaunchContext {
  /** Whether the tab's Pane runs in WSL or on an SSH host, where chat tabs are not offered. */
  unsupportedHost(panel: ToolPanel): string | undefined;
}

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' } satisfies Record<ChatAgent, string>;

/** The agent process's environment: string values only, rebuilt at every start and never saved. */
export type ChatAgentEnv = Record<string, string>;

/**
 * The same Pane environment a terminal agent tab gets (PANE_*, runpane on PATH,
 * git attribution), so runpane report and Notify work from inside a chat tab.
 */
export function chatTabEnv(panel: ToolPanel, state: ChatPanelState): ChatAgentEnv {
  const inherited = interactiveTerminalEnv();
  delete inherited.PANE_ORCHESTRATION_SESSION_ID;
  delete inherited.PANE_SESSION_DIR;
  const config = getRuntimeConfigManager().getConfig();
  const env = {
    ...inherited,
    ...getGitAttributionEnv(config),
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
  if (state.orchestrationSessionId) session.PANE_ORCHESTRATION_SESSION_ID = state.orchestrationSessionId;
  if (state.sessionFolder) session.PANE_SESSION_DIR = state.sessionFolder;
  return withRunpaneBinOnPath({ ...env, ...session });
}

/** Runs the person's own installed claude or codex through its pinned ACP adapter. */
export class AgentChatLauncher implements ChatTabLauncher {
  constructor(private readonly options: { secrets: ChatTabSecrets; context: ChatLaunchContext; profiles?: ChatProfileResolver }) {}

  async resolve(panel: ToolPanel, state: ChatPanelState): Promise<ResolvedLaunch> {
    const unsupported = this.options.context.unsupportedHost(panel);
    if (unsupported) throw new PaneError('CHAT_UNSUPPORTED_HOST', unsupported, 'Open "Claude in Terminal" or "Codex in Terminal" from the + menu instead.');
    const env = chatTabEnv(panel, state);
    const executable = findExecutableInPath(state.agent);
    if (!executable) {
      throw new PaneError('CHAT_AGENT_NOT_INSTALLED', `${AGENT_NAMES[state.agent]} is not installed on this machine, or not on its PATH.`, `Install ${AGENT_NAMES[state.agent]}, then press Retry. Pane never uses a bundled copy.`);
    }
    // Claude chat tabs always run the person's installed, unmodified claude.
    if (state.agent === 'claude') env.CLAUDE_CODE_EXECUTABLE = providerScript(executable, 'claude') ?? executable;
    else env.CODEX_PATH = executable;
    const key = this.options.secrets.apiKey(state.agent);
    if (key && state.agent === 'claude') env.ANTHROPIC_API_KEY = key;
    if (key && state.agent === 'codex') { env.OPENAI_API_KEY = key; env.CODEX_API_KEY = key; }
    if (state.launch.kind === 'profile') {
      if (!this.options.profiles) throw new PaneError('CHAT_PROFILE_UNSUPPORTED', 'This Pane cannot start Agent Farm profiles in chat tabs yet.', 'Start the profile in a terminal tab.');
      return this.options.profiles.resolve(panel, state, env);
    }
    // The bundled adapter checks the same CLI, in the folder and environment it will run in (#1236).
    await installAdapter(state.agent, executable, { cwd: state.cwd, env });
    const entry = adapterEntry(state.agent);
    if (!entry) throw new PaneError('CHAT_ADAPTER_MISSING', `This Pane build is missing its bundled ${AGENT_NAMES[state.agent]} chat adapter.`, 'Reinstall Pane from runpane.com. Terminal agent tabs are not affected.');
    const launch: ResolvedLaunch = { command: { executable: process.execPath, args: [entry], cwd: state.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } };
    if (state.launch.mode) launch.mode = state.launch.mode;
    const meta = sessionFolderMeta(state);
    if (meta) launch.meta = meta;
    return launch;
  }
}

/** The ACP session mode that matches an agent's "skip approvals" flag. */
const BYPASS_MODES = { claude: 'bypassPermissions', codex: 'agent-full-access' } satisfies Record<ChatAgent, string>;

/**
 * A terminal launch command a chat tab can run instead: the plain agent (with its
 * skip-approvals flag as the session mode) or `agent-farm run <profile> [--arg k=v]`.
 * Anything else (wrappers, other flags) keeps its terminal, where it runs unchanged.
 */
export function chatLaunchFromCommand(command: string | undefined, agent: ChatAgent): ChatTabLaunch | undefined {
  const tokens = tokenizeShellCommand(command?.trim() || agent, process.platform);
  if (!tokens?.length) return undefined;
  if (tokens[0] === agent) {
    const rest = tokens.slice(1);
    const bypass = agent === 'claude' ? '--dangerously-skip-permissions' : '--yolo';
    if (rest.some(token => token !== bypass)) return undefined;
    return rest.length ? { kind: 'agent', mode: BYPASS_MODES[agent] } : { kind: 'agent' };
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
  if (agent !== 'claude' && agent !== 'codex') return { terminalReason: 'Chat tabs run only Claude and Codex.' };
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
  const tokens = tokenizeShellCommand(command.trim(), process.platform) ?? [];
  let model: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (tokens[0] === agent && token === '--model' && tokens[index + 1]) { model = tokens[index + 1]; index += 1; }
    else if (tokens[0] === agent && token.startsWith('--model=')) model = token.slice('--model='.length);
    // Pane's own Session folder access for a Session's Pane; the chat gets the same (sessionFolderMeta).
    else if (agent === 'claude' && tokens[0] === agent && token === '--settings' && context.sessionFolder && isSessionFolderSettings(tokens[index + 1] ?? '', context.sessionFolder)) index += 1;
    else rest.push(token);
  }
  const launch = chatLaunchFromCommand(rest.map(quoteToken).join(' '), agent);
  if (!launch) return { unsupported: firstUnsupported(rest, agent) };
  return model ? { launch, settings: { model } } : { launch };
}

/** The first token chatLaunchFromCommand cannot represent, for the switch's refusal. */
function firstUnsupported(tokens: string[], agent: ChatAgent): string {
  if (tokens[0] === agent) return tokens.slice(1).find(token => token !== (agent === 'claude' ? '--dangerously-skip-permissions' : '--yolo')) ?? tokens[0];
  if (tokens[0] === 'agent-farm' && tokens[1] === 'run') {
    for (let index = 3; index < tokens.length; index += 2) if (tokens[index] !== '--arg' || !tokens[index + 1]?.includes('=')) return tokens[index];
  }
  return tokens[0] ?? agent;
}

function quoteToken(token: string): string { return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`; }

/**
 * The chat-tab form of the Session folder access Pane gives Claude in a Session's Pane
 * (sessionFolderAccess.ts): the same settings, sent as `claudeCode.options.settings` on
 * session/new and session/load. A Session orchestrator works in its own folder, so it gets
 * none; Codex and Windows get none, as in terminals.
 */
export function sessionFolderMeta(state: Pick<ChatPanelState, 'agent' | 'cwd' | 'sessionFolder'>, platform: NodeJS.Platform = process.platform): JsonObject | undefined {
  if (state.agent !== 'claude' || platform === 'win32' || !state.sessionFolder || path.resolve(state.sessionFolder) === path.resolve(state.cwd)) return undefined;
  return { claudeCode: { options: { settings: claudeSessionFolderSettings(state.sessionFolder) } } };
}
