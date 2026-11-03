import path from 'path';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatAgent, ChatPanelState } from '../../../../shared/types/chatTab';
import { PaneError } from '../../../../shared/paneError';
import { getAppDirectory } from '../../utils/appDirectory';
import { findExecutableInPath, getShellPath } from '../../utils/shellPath';
import { interactiveTerminalEnv } from '../../utils/inheritedProcessEnv';
import { getGitAttributionEnv } from '../../utils/attribution';
import { getRuntimeConfigManager } from '../../core/runtime';
import { noteContextPath } from '../noteFiles';
import { withRunpaneBinOnPath } from '../runpaneShim';
import { adapterEntry, installAdapter } from '../agentChat/adapterSetup';
import { providerScript } from '../agentChat/hostCommand';
import { panePortFor } from '../panePort';
import type { ChatTabLauncher, ResolvedLaunch } from './manager';

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
      throw new PaneError('CHAT_AGENT_NOT_INSTALLED', `${AGENT_NAMES[state.agent]} is not installed on this machine, or not on its PATH.`, `Install ${AGENT_NAMES[state.agent]}, then press Restart. Pane never uses a bundled copy.`);
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
    await installAdapter(state.agent);
    const entry = adapterEntry(state.agent);
    if (!entry) throw new PaneError('CHAT_ADAPTER_INSTALL_FAILED', 'The chat adapter was not usable after setup.', 'Press Restart to set it up again.');
    return { command: { executable: process.execPath, args: [entry], cwd: state.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } };
  }
}
