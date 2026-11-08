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
import type { ChatTabNotifyBridge } from './notifyBridge';

/** Chat tab state lives in the panel's custom state; only the host writes it. */
const store: ChatTabStore = {
  panel: panelId => { const panel = panelManager.getPanel(panelId); return panel?.type === 'chat' ? panel : undefined; },
  state: panelId => {
    const panel = panelManager.getPanel(panelId);
    return panel?.type === 'chat' ? decodeChatPanelState(panel.state.customState) : undefined;
  },
  commit: (panelId, state) => panelManager.commitChatTab(panelId, state),
};

let manager: ChatTabManager | undefined;
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
 * adapters, so journeys never touch a real Claude or Codex account. A packaged
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
  });
  return manager;
}
