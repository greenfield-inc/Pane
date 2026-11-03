import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type { ChatAgent, ChatPanelState, ChatTabAnswer, ChatTabCreate } from '../../../shared/types/chatTab';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';
import { getRuntimeConfigManager } from '../core/runtime';
import { panelManager } from '../services/panelManager';
import { configureChatTabs, getChatTabManager } from '../services/chatTabs';
import { chatTabSecrets } from '../services/chatTabs/secrets';

const agentSchema = boundary.enumeration('claude', 'codex');
const imageSchema = boundary.object({ mimeType: boundary.string, data: boundary.string });
const sendSchema = boundary.object({ operationId: boundary.nonEmptyString, text: boundary.string, images: boundary.optional(boundary.array(imageSchema)) });
const createSchema = boundary.object({
  sessionId: boundary.nonEmptyString,
  agent: agentSchema,
  launch: boundary.optional(boundary.union(
    boundary.object({ kind: boundary.literal('agent') }),
    boundary.object({ kind: boundary.literal('profile'), profile: boundary.nonEmptyString, args: boundary.optional(boundary.record(boundary.string)) }),
  )),
  title: boundary.optional(boundary.string),
  initialInput: boundary.optional(boundary.string),
  activate: boundary.optional(boundary.boolean),
});
const answerSchema = boundary.union(
  boundary.object({ action: boundary.literal('accept'), content: boundary.record(boundary.json) }),
  boundary.object({ action: boundary.literal('decline') }),
  boundary.object({ action: boundary.literal('cancel') }),
);
const panelId = (value: PaneCommandValue) => decodeBoundary(value, boundary.nonEmptyString);

export const CHAT_TAB_CHANNELS = ['create', 'get', 'history', 'send', 'receipt', 'unqueue', 'configure', 'cancel', 'permission', 'answer', 'restart', 'sign-in', 'keys', 'set-key'] as const;

export function chatTabsEnabled(): boolean { return getRuntimeConfigManager().getConfig().chatTabsEnabled === true; }

const AGENT_TITLES = { claude: 'Claude', codex: 'Codex' } satisfies Record<ChatAgent, string>;

/** One command surface for Electron, daemon clients, the remote PWA and the phone. */
export function registerChatTabHandlers(ipcMain: IpcMain, services: AppServices, registry: PaneCommandRegistry): void {
  configureChatTabs({
    context: {
      unsupportedHost: panel => {
        const context = services.sessionManager.getProjectContext(panel.sessionId);
        if (context?.pathResolver.environment === 'wsl' || context?.commandRunner.wslContext) return 'Chat tabs do not run in WSL projects yet.';
        return undefined;
      },
    },
  });
  const manager = getChatTabManager();

  registry.register('chat-tab:create', async (value: PaneCommandValue) => {
    const request: ChatTabCreate = decodeBoundary(value, createSchema);
    return createChatTab(services, request);
  });
  registry.register('chat-tab:get', (id: string, limit?: number) => manager.view(panelId(id), limit === undefined ? undefined : decodeBoundary(limit, boundary.number)));
  registry.register('chat-tab:history', (id: string, before: number, limit: number) => manager.history(panelId(id), decodeBoundary(before, boundary.number), decodeBoundary(limit, boundary.number)));
  registry.register('chat-tab:send', (id: string, request: PaneCommandValue) => manager.send(panelId(id), decodeBoundary(request, sendSchema)));
  registry.register('chat-tab:receipt', (id: string, operationId: string) => manager.receipt(panelId(id), decodeBoundary(operationId, boundary.nonEmptyString)) ?? null);
  registry.register('chat-tab:unqueue', (id: string, operationId: string) => { manager.unqueue(panelId(id), decodeBoundary(operationId, boundary.nonEmptyString)); return undefined; });
  registry.register('chat-tab:configure', async (id: string, configId: string, chosen: string) => { await manager.configure(panelId(id), decodeBoundary(configId, boundary.nonEmptyString), decodeBoundary(chosen, boundary.string)); });
  registry.register('chat-tab:cancel', async (id: string) => { await manager.cancel(panelId(id)); });
  registry.register('chat-tab:permission', (id: string, requestId: string, optionId: string) => { manager.answerPermission(panelId(id), decodeBoundary(requestId, boundary.nonEmptyString), decodeBoundary(optionId, boundary.string)); return undefined; });
  registry.register('chat-tab:answer', (id: string, questionId: string, answer: PaneCommandValue) => {
    const decoded: ChatTabAnswer = decodeBoundary(answer, answerSchema);
    manager.answerQuestion(panelId(id), decodeBoundary(questionId, boundary.nonEmptyString), decoded);
    return undefined;
  });
  registry.register('chat-tab:restart', async (id: string) => { await manager.restart(panelId(id)); });
  registry.register('chat-tab:sign-in', async (id: string) => {
    const panel = panelManager.getPanel(panelId(id));
    const state = manager.view(panelId(id), 0, false);
    if (!panel) throw new PaneError('CHAT_PANEL_MISSING', 'This chat tab no longer exists.', 'Open another chat tab.');
    // Sign-in always happens in the agent's own flow on this machine; Pane never sees the login.
    // A wrapped launch runs exactly this command, without the agent-session flags Pane adds to claude.
    const command = state.agent === 'claude' ? 'claude auth login' : 'codex login';
    const terminal = await panelManager.createPanel({ sessionId: panel.sessionId, type: 'terminal', title: `Sign in to ${AGENT_TITLES[state.agent]}`, initialState: { initialCommand: command, launchCommand: command, launchMode: 'wrapped', preserveLaunchCommand: true }, announceActivation: true });
    return { panelId: terminal.id };
  });
  registry.register('chat-tab:keys', () => chatTabSecrets.status());
  registry.register('chat-tab:set-key', (agent: string, key: PaneCommandValue) => {
    chatTabSecrets.set(decodeBoundary(agent, agentSchema), decodeBoundary(key, boundary.nullable(boundary.string)));
    return chatTabSecrets.status();
  });
  for (const operation of CHAT_TAB_CHANNELS) registry.bindChannel(ipcMain, `chat-tab:${operation}`);
}

export async function createChatTab(services: AppServices, request: ChatTabCreate): Promise<{ panelId: string }> {
  if (!chatTabsEnabled()) throw new PaneError('CHAT_TABS_DISABLED', 'Chat tabs are turned off on this machine. No tab was created.', 'Turn on Chat tabs in Settings > Advanced > Experimental, or open a terminal agent tab.');
  const session = services.sessionManager.getSession(request.sessionId);
  if (!session?.worktreePath) throw new PaneError('CHAT_PANE_MISSING', 'That Pane was not found, so no chat tab was created.', 'Open the Pane first, then add the tab.');
  const state: ChatPanelState = { agent: request.agent, launch: request.launch ?? { kind: 'agent' }, cwd: session.worktreePath, status: 'starting' };
  if (request.initialInput) state.initialInput = request.initialInput;
  const title = request.title ?? (request.launch?.kind === 'profile' ? request.launch.profile.split('/').pop() ?? AGENT_TITLES[request.agent] : AGENT_TITLES[request.agent]);
  const panel = await panelManager.createPanel({ sessionId: request.sessionId, type: 'chat', title, initialState: { customState: state }, activate: request.activate });
  void getChatTabManager().ensure(panel.id).catch(error => console.warn(`[ChatTabs] ${panel.id} did not start: ${error instanceof Error ? error.message : String(error)}`));
  return { panelId: panel.id };
}
