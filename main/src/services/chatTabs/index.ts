import path from 'path';
import { PaneError } from '../../../../shared/paneError';
import { getAppDirectory } from '../../utils/appDirectory';
import { getPaneEventSink } from '../../core/runtime';
import { panelManager } from '../panelManager';
import { ChatTabManager, type ChatTabStore } from './manager';
import { AgentChatLauncher, type ChatLaunchContext, type ChatProfileResolver } from './launch';
import { chatTabSecrets } from './secrets';
import { decodeChatPanelState } from './state';

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
let context: ChatLaunchContext = { unsupportedHost: () => undefined };
let profiles: ChatProfileResolver | undefined;

/** Called once at startup with what only the IPC layer knows (project hosts, Agent Farm). */
export function configureChatTabs(options: { context: ChatLaunchContext; profiles?: ChatProfileResolver }): void {
  context = options.context;
  profiles = options.profiles;
}

export function getChatTabManager(): ChatTabManager {
  manager ??= new ChatTabManager({
    store,
    launcher: new AgentChatLauncher({
      secrets: chatTabSecrets,
      context: { unsupportedHost: panel => context.unsupportedHost(panel) },
      profiles: { resolve: (panel, state, env) => {
        if (!profiles) throw new PaneError('CHAT_PROFILE_UNSUPPORTED', 'This Pane cannot start Agent Farm profiles in chat tabs yet.', 'Start the profile in a terminal tab.');
        return profiles.resolve(panel, state, env);
      } },
    }),
    send: (channel, payload) => getPaneEventSink().send(channel, payload),
    spoolDirectory: path.join(getAppDirectory(), 'chat-tabs'),
  });
  return manager;
}
