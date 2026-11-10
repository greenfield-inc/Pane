import type { IpcMain } from 'electron';
import path from 'path';
import { teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { teammateSecretRefusal } from '../../../shared/types/paneSecrets';
import type { AppServices } from './types';
import type { ChatAgent, ChatPanelState, ChatTabAnswer, ChatTabCreate } from '../../../shared/types/chatTab';
import type { CreatePanelRequest, PanelOpener, ToolPanel } from '../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';
import { getRuntimeConfigManager } from '../core/runtime';
import { panelManager } from '../services/panelManager';
import { configureChatTabs, getChatTabManager } from '../services/chatTabs';
import { chatTabSecrets } from '../services/chatTabs/secrets';
import { AgentFarmProfiles, printedCli } from '../services/chatTabs/agentFarm';
import { chatTabEnv } from '../services/chatTabs/launch';
import { adapterEntry, adapterFileForPlainNode, installAdapter } from '../services/agentChat/adapterSetup';
import { findExecutableInPath } from '../utils/shellPath';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { switchToChat, terminalConversation, terminalRestored, type SwitchToChatPorts, type TranscriptLookup } from '../services/chatTabs/switchToChat';
import { getDockTerminalPanel } from '../../../shared/utils/terminalDock';
import { previewSessionSwitch, switchSessionToChat, type SessionSwitchPorts } from '../services/chatTabs/switchSession';
import { getAppDirectory } from '../utils/appDirectory';
import { canReadClaudeTranscripts, findClaudeSessionTranscript } from '../services/claudeSessionTranscript';
import type { TerminalPanelState } from '../../../shared/types/panels';

const agentSchema = boundary.enumeration('claude', 'codex');
const imageSchema = boundary.object({ mimeType: boundary.string, data: boundary.string });
const sendSchema = boundary.object({ operationId: boundary.nonEmptyString, text: boundary.string, images: boundary.optional(boundary.array(imageSchema)) });
const createSchema = boundary.object({
  sessionId: boundary.nonEmptyString,
  agent: boundary.optional(agentSchema),
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

/** Agent Farm profiles (package 2's run --print-acp) with Pane's bundled adapters. */
const agentFarmProfiles = new AgentFarmProfiles({
  executable: () => findExecutableInPath('agent-farm') ?? undefined,
  adapter: async agent => {
    const entry = adapterEntry(agent);
    if (!entry) throw new PaneError('CHAT_ADAPTER_MISSING', 'This Pane build is missing its bundled chat adapter.', 'Reinstall Pane from runpane.com. Terminal agent tabs are not affected.');
    return adapterFileForPlainNode(entry, path.join(getAppDirectory(), 'agent-adapters'));
  },
  checkCli: (agent, context) => installAdapter(agent, printedCli(agent, context.env, findExecutableInPath), context),
});

const CHAT_TAB_CHANNELS = ['create', 'switch', 'preview-session-switch', 'switch-session', 'get', 'history', 'send', 'receipt', 'unqueue', 'configure', 'cancel', 'permission', 'answer', 'restart', 'conversations', 'resume', 'dismiss-banner', 'sign-in', 'keys', 'set-key'] as const;

function chatTabsEnabled(): boolean { return getRuntimeConfigManager().getConfig().chatTabsEnabled === true; }

const AGENT_TITLES = { claude: 'Claude', codex: 'Codex' } satisfies Record<ChatAgent, string>;

/** One command surface for Electron, daemon clients, the remote PWA and the phone. */
export function registerChatTabHandlers(ipcMain: IpcMain, services: AppServices, registry: PaneCommandRegistry): void {
  configureChatTabs({
    profiles: agentFarmProfiles,
    context: {
      unsupportedHost: panel => {
        const context = services.sessionManager.getProjectContext(panel.sessionId);
        if (context?.pathResolver.environment === 'wsl' || context?.commandRunner.wslContext) return 'Chat tabs do not run in WSL projects yet.';
        return undefined;
      },
      projectEnv: panel => services.sessionManager.resolveProjectEnv(panel.sessionId, panel.metadata?.teammate ?? null),
    },
  });
  const manager = getChatTabManager();

  registry.register('chat-tab:create', async (value: PaneCommandValue) => {
    const request: ChatTabCreate = decodeBoundary(value, createSchema);
    return createChatTab(services, request);
  });
  registry.register('chat-tab:switch', (id: string) => switchToChat(panelId(id), switchPorts(services, registry)));
  // A whole Session, from its right-click menu, here or from All machines (machines:run).
  registry.register('chat-tab:preview-session-switch', (id: string) => previewSessionSwitch(decodeBoundary(id, boundary.nonEmptyString), sessionSwitchPorts(services, registry)));
  registry.register('chat-tab:switch-session', (id: string, panelIds?: PaneCommandValue) => switchSessionToChat(
    decodeBoundary(id, boundary.nonEmptyString),
    panelIds === undefined || panelIds === null ? undefined : decodeBoundary(panelIds, boundary.array(boundary.nonEmptyString)),
    sessionSwitchPorts(services, registry),
  ));
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
  registry.register('chat-tab:conversations', (id: string) => manager.conversations(panelId(id)));
  registry.register('chat-tab:resume', async (id: string, sessionId: string) => { await manager.resume(panelId(id), decodeBoundary(sessionId, boundary.nonEmptyString)); });
  registry.register('chat-tab:dismiss-banner', (id: string) => { manager.dismissBanner(panelId(id)); return undefined; });
  registry.register('chat-tab:sign-in', async (id: string) => {
    // Sign-in sets the owner's own agent account on this machine.
    const teammate = teammatePaneCaller();
    if (teammate) throw teammateSecretRefusal(teammate, 'sign a chat tab in');
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
    const teammate = teammatePaneCaller();
    if (teammate) throw teammateSecretRefusal(teammate, 'change a chat tab key');
    const decoded = decodeBoundary(key, boundary.nullable(boundary.string));
    // Removing a key always works; saving one needs chat tabs on, like opening a tab.
    if (decoded !== null && !chatTabsEnabled()) throw new PaneError('CHAT_TABS_DISABLED', 'Chat tabs are turned off on this machine, so the key was not saved.', 'Turn on Chat tabs in Settings > Advanced > Experimental, then save the key.');
    chatTabSecrets.set(decodeBoundary(agent, agentSchema), decoded);
    return chatTabSecrets.status();
  });
  for (const operation of CHAT_TAB_CHANNELS) registry.bindChannel(ipcMain, `chat-tab:${operation}`);
}

/** `openedBy` is set only by runpane (`--source`), never from a renderer's request. */
export async function createChatTab(services: AppServices, request: ChatTabCreate, openedBy?: PanelOpener): Promise<{ panelId: string }> {
  if (!chatTabsEnabled()) throw new PaneError('CHAT_TABS_DISABLED', 'Chat tabs are turned off on this machine. No tab was created.', 'Turn on Chat tabs in Settings > Advanced > Experimental, or open a terminal agent tab.');
  const session = services.sessionManager.getSession(request.sessionId);
  if (!session?.worktreePath) throw new PaneError('CHAT_PANE_MISSING', 'That Pane was not found, so no chat tab was created.', 'Open the Pane first, then add the tab.');
  const launch = request.launch ?? { kind: 'agent' as const };
  // A profile names its own harness; Agent Farm says which when the caller did not.
  let agent = request.agent;
  if (!agent && launch.kind === 'profile') {
    const probe: ChatPanelState = { agent: 'claude', launch, cwd: session.worktreePath, status: 'starting' };
    const placeholder: ToolPanel = { id: 'new', sessionId: request.sessionId, type: 'chat', title: '', state: { isActive: false }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
    agent = (await agentFarmProfiles.print(launch.profile, launch.args ?? {}, 'claude', session.worktreePath, chatTabEnv(placeholder, probe))).harness;
  }
  if (!agent) throw new PaneError('CHAT_AGENT_REQUIRED', 'No agent was named for the chat tab, so none was created.', 'Choose Claude or Codex, or name an Agent Farm profile.');
  const state: ChatPanelState = { agent, launch, cwd: session.worktreePath, status: 'starting' };
  if (request.initialInput) state.initialInput = request.initialInput;
  const title = request.title ?? (launch.kind === 'profile' ? launch.profile.split('/').pop() ?? AGENT_TITLES[agent] : AGENT_TITLES[agent]);
  const create: CreatePanelRequest = { sessionId: request.sessionId, type: 'chat', title, initialState: { customState: state }, activate: request.activate, announceActivation: request.activate !== false };
  if (openedBy) create.metadata = { openedBy };
  const panel = await panelManager.createPanel(create);
  void getChatTabManager().ensure(panel.id).catch(error => console.warn(`[ChatTabs] ${panel.id} did not start: ${error instanceof Error ? error.message : String(error)}`));
  return { panelId: panel.id };
}

/** A chat that has not reopened by now is treated as failed, so the terminal comes back. */
const REOPEN_LIMIT_MS = 3 * 60_000;
const resumeResultSchema = boundary.object({ readiness: boundary.optional(boundary.object({ ok: boundary.boolean, blocked: boundary.optional(boundary.object({ message: boundary.string })), reason: boundary.optional(boundary.object({ code: boundary.string, message: boundary.string })), state: boundary.optional(boundary.object({ running: boundary.boolean })) })) });
const deleteResultSchema = boundary.object({ success: boundary.boolean, error: boundary.optional(boundary.string) });

/**
 * A Session's terminal tabs, as its membership has them: every tab of its own Pane, then for each
 * Pane in it that is not archived, every tab when the whole Pane is linked, or only its linked tabs.
 */
function sessionSwitchPorts(services: AppServices, registry: PaneCommandRegistry): SessionSwitchPorts {
  return {
    ...switchPorts(services, registry),
    sessionTerminals: sessionId => {
      const membership = services.orchestrationSessionManager?.workspaceMembership(sessionId);
      if (!membership) return undefined;
      const panes: Array<[string, readonly string[]]> = [...membership.ownPaneIds].map(paneId => [paneId, []]);
      for (const [paneId, panelIds] of membership.panes) if (!membership.ownPaneIds.has(paneId)) panes.push([paneId, panelIds]);
      return panes.flatMap(([paneId, linked]) => {
        const paneName = membership.ownPaneIds.has(paneId) ? 'Session' : services.sessionManager.getSession(paneId)?.name ?? paneId;
        const terminals = panelManager.getPanelsBySessionAndType(paneId, 'terminal');
        // The Pane's terminal dock is a plain shell below the tabs, not a tab: leave it out.
        const dock = getDockTerminalPanel(terminals);
        return terminals.filter(panel => panel !== dock && (linked.length === 0 || linked.includes(panel.id)))
          .sort((a, b) => (a.metadata.position ?? 0) - (b.metadata.position ?? 0))
          .map(panel => ({ panel, paneName }));
      });
    },
  };
}

/** Whether a Claude conversation has a transcript Pane can see; two sharing an ID is not a conversation Pane can be sure of. */
const transcriptLookup: TranscriptLookup = id => {
  if (!canReadClaudeTranscripts()) return 'unknown';
  try { return findClaudeSessionTranscript(id) ? 'found' : 'missing'; }
  catch (error) {
    console.warn(`[ChatTabs] Could not tell whether conversation ${id} has messages: ${error instanceof Error ? error.message : String(error)}`);
    return 'ambiguous';
  }
};

/** Switch to chat over the real terminal, chat tab and Session owners. */
function switchPorts(services: AppServices, registry: PaneCommandRegistry): SwitchToChatPorts {
  const manager = getChatTabManager();
  const releasePermanent = async (id: string) => {
    const panel = panelManager.getPanel(id);
    if (panel?.metadata.permanent) await panelManager.updatePanel(id, { metadata: { ...panel.metadata, permanent: false } });
  };
  return {
    chatTabsEnabled,
    panel: id => panelManager.getPanel(id),
    paneDirectory: paneId => services.sessionManager.getSession(paneId)?.worktreePath,
    terminal: {
      busy: id => terminalPanelManager.isAgentMidTurn(id),
      conversation: async id => {
        // SAFETY: Switch to chat only asks this of terminal panels, which persist TerminalPanelState.
        const state = (panelManager.getPanel(id)?.state.customState ?? {}) as TerminalPanelState;
        return terminalConversation(state, terminalPanelManager.currentLaunchId(id), transcriptLookup);
      },
      stop: id => terminalPanelManager.stopForPromotion(id),
      restart: async id => {
        const { readiness } = decodeBoundary(await registry.invoke('runpane:panels:resume', [{ panelId: id, waitReady: true }]), resumeResultSchema);
        if (!terminalRestored(readiness)) throw new Error(readiness?.reason?.message ?? 'its agent did not start again');
      },
      close: async id => {
        await releasePermanent(id);
        const result = decodeBoundary(await registry.invoke('panels:delete', [id]), deleteResultSchema);
        if (!result.success) throw new Error(result.error ?? 'unknown error');
      },
    },
    chat: {
      create: async (replaces, state) => (await panelManager.createPanel({ sessionId: replaces.sessionId, type: 'chat', title: replaces.title, initialState: { customState: state }, metadata: { position: replaces.metadata.position, replacesPanelId: replaces.id, teammate: replaces.metadata.teammate }, activate: false, announceActivation: false })).id,
      start: id => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PaneError('CHAT_SWITCH_TIMEOUT', 'The agent did not reopen the conversation within 3 minutes.', 'Keep working in the terminal, then try again.')), REOPEN_LIMIT_MS); });
        return Promise.race([manager.ensure(id), limit]).finally(() => clearTimeout(timer));
      },
      banner: id => manager.view(id, 0, false).banner,
      close: async id => { await manager.close(id); await panelManager.deletePanel(id); },
      activate: async id => {
        const panel = panelManager.getPanel(id);
        if (panel) await panelManager.setActivePanel(panel.sessionId, id);
      },
    },
    adoptSessionPanel: (from, to) => services.orchestrationSessionManager?.adoptAgentPanel(from, to) ?? Promise.resolve({ owner: 'chat' }),
    sessionLaunchCommand: id => services.orchestrationSessionManager?.agentLaunchCommand(id),
  };
}
