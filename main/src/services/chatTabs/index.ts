import path from 'path';
import { PaneError } from '../../../../shared/paneError';
import { getAppDirectory } from '../../utils/appDirectory';
import { getPaneEventSink } from '../../core/runtime';
import { panelManager } from '../panelManager';
import { terminalPanelManager } from '../terminalPanelManager';
import { app } from 'electron';
import { ChatTabManager, type ChatTabLauncher, type ChatTabStore } from './manager';
import { AgentChatLauncher, chatTabEnv, type ChatLaunchContext, type ChatProfileResolver } from './launch';
import { chatTabSecrets } from './secrets';
import { decodeChatPanelState } from './state';
import { databaseService } from '../database';
import type { TerminalPanelState, ToolPanel } from '../../../../shared/types/panels';
import type { ChatTabNotifyBridge } from './notifyBridge';
import { agentConfig } from '../../../../shared/agents';
import { ChatAgentCatalog } from './agentCatalog';
import { isOnPath } from '../../utils/onPath';
import { chatAgentName, getAgentRegistry, registryCatalogEntries } from '../agentRegistry';

/** Chat tab state lives in the panel's custom state; only the host writes it. */
const store: ChatTabStore = {
  panel: panelId => { const panel = panelManager.getPanel(panelId); return panel?.type === 'chat' ? panel : undefined; },
  state: panelId => {
    const panel = panelManager.getPanel(panelId);
    return panel?.type === 'chat' ? decodeChatPanelState(panel.state.customState) : undefined;
  },
  commit: (panelId, state) => panelManager.commitChatTab(panelId, state),
};

/**
 * Conversations open in Pane tabs on this machine other than `panelId` and the terminal it replaced
 * (D-282): every chat tab's saved conversation, and every terminal tab's whose conversation a chat can load, running or
 * not, since a terminal resumes its conversation when it starts again.
 */
function openConversations(panelId: string): Map<string, { panelId: string; title: string }> {
  const replaced = panelManager.getPanel(panelId)?.metadata.replacesPanelId;
  const open = new Map<string, { panelId: string; title: string }>();
  for (const row of databaseService.getActivePanels()) {
    if (row.id === panelId || row.id === replaced) continue;
    const panel = panelManager.getPanel(row.id) ?? row;
    const id = conversationOf(panel);
    if (id && !open.has(id)) open.set(id, { panelId: panel.id, title: panel.title });
  }
  return open;
}

function conversationOf(panel: ToolPanel): string | undefined {
  if (panel.type === 'chat') return decodeChatPanelState(panel.state.customState)?.acpSessionId;
  if (panel.type !== 'terminal') return undefined;
  // SAFETY: terminal panels persist TerminalPanelState as their custom state.
  const state = (panel.state.customState ?? {}) as TerminalPanelState;
  return state.agentType && agentConfig(state.agentType)?.chat?.terminalConversationsLoad ? state.agentSessionId : undefined;
}

let manager: ChatTabManager | undefined;
let catalog: ChatAgentCatalog | undefined;

/** The agents this host can open as chat tabs (chat-tab:agents), with what each supports. */
export function getChatAgentCatalog(): ChatAgentCatalog {
  // With the scripted test agent (development and end-to-end tests only), it stands in for every agent.
  const scripted = !!process.env.PANE_CHAT_TEST_AGENT && !app.isPackaged;
  catalog ??= new ChatAgentCatalog({ file: path.join(getAppDirectory(), 'chat-agent-capabilities.json'), onPath: scripted ? async () => true : isOnPath, registryAgents: registryCatalogEntries });
  return catalog;
}
let context: ChatLaunchContext = { unsupportedHost: () => undefined, projectEnv: async () => ({ env: {}, warnings: [] }) };
let profiles: ChatProfileResolver | undefined;
let notifyBridge: ChatTabNotifyBridge | undefined;

/** Chat tab approvals and questions in Notify and on the phone (#1215's queue); set once Notify starts. */
export function setChatTabNotify(bridge: ChatTabNotifyBridge | undefined): void { notifyBridge = bridge; }

/** Called once at startup with what only the IPC layer knows (project hosts, Agent Farm). */
export function configureChatTabs(options: { context: ChatLaunchContext; profiles?: ChatProfileResolver }): void {
  context = options.context;
  profiles = options.profiles;
}

/**
 * Development and end-to-end tests only: PANE_CHAT_TEST_AGENT names a scripted
 * ACP agent (testing/scriptedAgent.mjs) that chat tabs run instead of the real
 * adapters, so journeys never touch a real agent account. A packaged
 * Pane ignores it.
 */
function scriptedAgentLauncher(): ChatTabLauncher | undefined {
  const script = process.env.PANE_CHAT_TEST_AGENT;
  if (!script || app.isPackaged) return undefined;
  return {
    resolve: async (panel, state) => {
      const env = chatTabEnv(panel, state);
      return { command: { executable: process.execPath, args: [script], cwd: state.cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1', SCRIPTED_AGENT_STORE: path.join(getAppDirectory(), 'scripted-agent') } } };
    },
  };
}

export function getChatTabManager(): ChatTabManager {
  manager ??= new ChatTabManager({
    store,
    launcher: scriptedAgentLauncher() ?? new AgentChatLauncher({
      secrets: chatTabSecrets,
      registry: { resolve: agent => getAgentRegistry().resolve(agent) },
      context: { unsupportedHost: panel => context.unsupportedHost(panel), projectEnv: panel => context.projectEnv(panel) },
      profiles: { resolve: (panel, state, env) => {
        if (!profiles) throw new PaneError('CHAT_PROFILE_UNSUPPORTED', 'This Pane cannot start Agent Farm profiles in chat tabs yet.', 'Start the profile in a terminal tab.');
        return profiles.resolve(panel, state, env);
      } },
    }),
    send: (channel, payload) => getPaneEventSink().send(channel, payload),
    spoolDirectory: path.join(getAppDirectory(), 'chat-tabs'),
    // The same agent-status stream terminal agent tabs feed: Session live activity,
    // update holds and keep-awake follow chat tabs too.
    onStatus: event => terminalPanelManager.emit('agent-status', event),
    onView: view => notifyBridge?.observe(view),
    onClosed: panelId => notifyBridge?.forget(panelId),
    openConversations,
    agentName: chatAgentName,
    onInitialized: (agent, response) => {
      getChatAgentCatalog().record(agent, response);
      // A registry agent that started no longer needs versions no tab runs (D-15). Every running
      // tab's folder stays: its process loads files from it. A cleanup error never stops the tab.
      if (!getAgentRegistry().installedRecord(agent)) return;
      try { getAgentRegistry().removeVersionsExcept(agent, getChatTabManager().launchedVersions(agent)); }
      catch (error) { console.warn(`[AgentRegistry] Could not remove ${agent}'s older versions: ${error instanceof Error ? error.message : String(error)}`); }
    },
  });
  return manager;
}
