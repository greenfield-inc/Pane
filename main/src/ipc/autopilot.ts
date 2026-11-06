import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { paneCommandCaller } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type { NotifyService } from '../services/notify/notifyService';
import { AutopilotManager, type AutopilotSessionInfo } from '../services/autopilot/autopilotManager';
import { connectAutopilotEvents } from '../services/autopilot/autopilotEvents';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { getChatTabManager } from '../services/chatTabs';
import { chatLaunchFromCommand } from '../services/chatTabs/launch';
import { decodeChatPanelState } from '../services/chatTabs/state';
import { getAppDirectory } from '../utils/appDirectory';
import { getPaneEventSink } from '../core/runtime';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import type { PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import type { AutopilotDocument, AutopilotSnapshot, AutopilotStackPushRequest } from '../../../shared/types/autopilot';

const stackCommandSchema = boundary.union(
  boundary.object({ type: boundary.literal('step'), direction: boundary.union(boundary.literal(1), boundary.literal(-1)) }),
  boundary.object({ type: boundary.literal('show'), id: boundary.nonEmptyString }),
  boundary.object({ type: boundary.literal('dismiss'), id: boundary.nonEmptyString }),
);
const pushSchema = boundary.object({
  item: boundary.optional(boundary.string),
  file: boundary.optional(boundary.string),
  url: boundary.optional(boundary.string),
  session: boundary.optional(boundary.string),
  title: boundary.optional(boundary.string),
  note: boundary.optional(boundary.string),
  next: boundary.optional(boundary.boolean),
  tabs: boundary.optional(boundary.array(boundary.object({
    label: boundary.optional(boundary.string),
    path: boundary.optional(boundary.string),
    url: boundary.optional(boundary.string),
  }))),
});
const remoteCommandTypeSchema = boundary.object({ type: boundary.string });
/** The phone asks for an HTML page inline: it can't load the computer's file URL. */
const readDocOptionsSchema = boundary.object({ inline: boundary.optional(boundary.boolean) });

const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;

type AutopilotServices = Pick<AppServices, 'configManager' | 'sessionManager' | 'orchestrationSessionManager' | 'skillCacheManager' | 'workspaceJournal'>;

/**
 * Autopilot's channels: `autopilot:*` for Pane's UI (the person), `runpane:autopilot:*` for the
 * CLI and MCP, plus a guard on every command that refuses answers from Autopilot (D-66).
 */
export function registerAutopilotHandlers(services: AutopilotServices, commandRegistry: PaneCommandRegistry, notify: NotifyService): AutopilotManager {
  let sessionsList: AutopilotSessionInfo[] = [];
  const sessionListeners = new Set<() => void>();
  const refreshSessions = async () => {
    const manager = services.orchestrationSessionManager;
    if (!manager) return;
    try {
      const { sessions } = await manager.list();
      sessionsList = sessions.map(session => ({ id: session.id, name: session.name, archived: session.archived, paneId: session.internalSessionId }));
      for (const listener of sessionListeners) listener();
    } catch { /* The Sessions list reports its own failure; the walk keeps the last list. */ }
  };
  services.orchestrationSessionManager?.on('changed', () => void refreshSessions());
  void refreshSessions();

  const chatTabs = () => getChatTabManager();
  const manager = new AutopilotManager({
    root: path.join(getAppDirectory(), 'autopilot'),
    config: {
      autopilotEnabled: () => services.configManager.getConfig().autopilotEnabled === true,
      chatTabsEnabled: () => services.configManager.getConfig().chatTabsEnabled === true,
      setAutopilotEnabled: async (enabled) => { await services.configManager.updateConfig({ autopilotEnabled: enabled }); },
    },
    owner: {
      exists: (paneId) => !!services.sessionManager.getSession(paneId),
      create: (paneId, title, folder) => {
        // Hidden and detached, like a Session's owner Pane, but with no Session record (D-69).
        const pane = services.sessionManager.createSessionWithId(paneId, title, folder, '', 'autopilot', 'ignore', undefined, false, undefined, 'none', undefined, undefined, false, { detached: true, hidden: true });
        services.sessionManager.updateSession(pane.id, { status: 'stopped' });
      },
    },
    chat: {
      exists: (panelId) => panelManager.getPanel(panelId)?.type === 'chat',
      create: async (panelId, ownerPaneId, title, state) => {
        await panelManager.createPanel({ id: panelId, sessionId: ownerPaneId, type: 'chat', title, initialState: { customState: state }, metadata: { permanent: true } });
      },
      ensure: (panelId) => chatTabs().ensure(panelId),
      isRunning: (panelId) => chatTabs().isRunning(panelId),
      send: (panelId, text) => { chatTabs().send(panelId, { operationId: `autopilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text }); },
      stop: (panelId, message, next) => chatTabs().stop(panelId, { message, next }),
      resume: async (panelId) => {
        const saved = decodeChatPanelState(panelManager.getPanel(panelId)?.state.customState);
        // A queued message would be delivered as soon as the agent starts: a turn before Start (D-57).
        if (!saved?.acpSessionId || chatTabs().view(panelId, 0, false).queue.length > 0) return false;
        await chatTabs().ensure(panelId);
        return true;
      },
      isBusy: (panelId) => { const state = chatTabs().agentState(panelId); return state === 'working' || state === 'blocked'; },
      unqueueWhere: (panelId, match) => {
        const queued = chatTabs().view(panelId, 0, false).queue.filter(prompt => match(prompt.text));
        for (const prompt of queued) chatTabs().unqueue(panelId, prompt.operationId);
        return queued.length;
      },
      // Chat tabs report status on the same stream as terminal agent tabs.
      subscribe: (listener) => {
        const onStatus = (event: PanelAgentStatusEvent) => listener(event.panelId);
        terminalPanelManager.on('agent-status', onStatus);
        return () => { terminalPanelManager.off('agent-status', onStatus); };
      },
    },
    notify: {
      items: () => notify.queue.snapshot().items,
      subscribe: (listener) => { notify.queue.on('change', listener); return () => notify.queue.off('change', listener); },
      // Pane's own question to the person (Sentinel stopped on a restart): filed under Autopilot, pushed like any other.
      ask: (question) => notify.queue.ask({ question, source: { name: 'Autopilot', agent: 'Pane', autopilot: true } }),
    },
    sessions: {
      list: () => sessionsList,
      subscribe: (listener) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
    },
    launch: () => chatLaunchFromCommand(RUNPANE_CONTRACT.agentTemplates.claude.command, 'claude') ?? { kind: 'agent' },
    skillPath: path.join(services.skillCacheManager?.paneChatSkillsRoot ?? path.join(getAppDirectory(), 'skills', 'pane-chat', 'skills'), 'pane-autopilot', 'SKILL.md'),
  });
  manager.on('changed', (snapshot: AutopilotSnapshot) => getPaneEventSink().send('autopilot:changed', snapshot));
  void manager.initialize().catch(error => console.warn('[Autopilot] Could not prepare the current run:', error));

  commandRegistry.addGuard((channel, args, caller) => refuseAnswers(manager, notify, channel, args, caller));
  // Autopilot's watch kinds (item.*, session.*, orchestrator.turn_ended), journalled for `--kinds` watches only.
  if (services.workspaceJournal) connectAutopilotEvents({
    journal: services.workspaceJournal,
    notify: {
      waiting: () => notify.queue.waitingItems(),
      items: () => notify.queue.snapshot().items,
      subscribe: (listener) => { notify.queue.on('change', listener); return () => notify.queue.off('change', listener); },
    },
    sessions: services.orchestrationSessionManager && {
      list: async () => (await services.orchestrationSessionManager?.list())?.sessions.map(session => ({ id: session.id, name: session.name, archived: session.archived, paneId: session.internalSessionId })) ?? [],
      subscribe: (listener) => { services.orchestrationSessionManager?.on('changed', listener); return () => { services.orchestrationSessionManager?.off('changed', listener); }; },
    },
  });

  // Pane's own UI: the person.
  commandRegistry.register('autopilot:snapshot', () => manager.snapshot());
  commandRegistry.register('autopilot:set-enabled', (enabled: PaneCommandValue) => manager.setEnabled(decodeBoundary(enabled, boundary.boolean)));
  commandRegistry.register('autopilot:start', () => manager.start());
  commandRegistry.register('autopilot:pause', () => manager.pause());
  commandRegistry.register('autopilot:go-on', () => manager.goOn());
  commandRegistry.register('autopilot:sentinel', (on: PaneCommandValue) => manager.setSentinel(decodeBoundary(on, boundary.boolean)));
  commandRegistry.register('autopilot:new-run', () => manager.newRun());
  // Settings › Autopilot › Your instructions (D-196): the person's own file, under Pane's rules.
  commandRegistry.register('autopilot:instructions', () => manager.instructions());
  commandRegistry.register('autopilot:set-instructions', (text: PaneCommandValue) => manager.setInstructions(decodeBoundary(text, boundary.string)));
  // The desktop view or the phone screen opened: with Sentinel on, the person may be back (J29).
  commandRegistry.register('autopilot:opened', () => { manager.opened(); return manager.snapshot(); });
  commandRegistry.register('autopilot:stack', (command: PaneCommandValue) => manager.moveStack(decodeBoundary(command, stackCommandSchema)));
  commandRegistry.register('autopilot:push', (request: PaneCommandValue) => manager.pushToStack(decodeBoundary(request, pushSchema)));
  commandRegistry.register('autopilot:read-doc', (file: PaneCommandValue, options?: PaneCommandValue) => readDocument(
    manager,
    decodeBoundary(file, boundary.nonEmptyString),
    { inline: decodeBoundary(options ?? {}, readDocOptionsSchema).inline === true, links: () => itemLinkPaths(notify) },
  ));

  // runpane and the pane MCP.
  commandRegistry.register('runpane:autopilot:status', () => ({ ok: true, ...manager.snapshot() }));
  commandRegistry.register('runpane:autopilot:waiting', () => {
    requireOn(manager);
    return { ok: true, items: manager.waiting() };
  });
  commandRegistry.register('runpane:autopilot:stack', () => {
    requireOn(manager);
    const { stack } = manager.snapshot();
    return { ok: true, ...stack };
  });
  commandRegistry.register('runpane:autopilot:stack-push', (request: PaneCommandValue) => {
    const decoded: AutopilotStackPushRequest = decodeBoundary(request, pushSchema);
    const { snapshot, entry } = manager.push(decoded, paneCommandCaller());
    return { ok: true, entry, shown: snapshot.stack.shownId === entry.id, position: snapshot.stack.entries.findIndex(candidate => candidate.id === entry.id) + 1, total: snapshot.stack.entries.length };
  });

  return manager;
}

function requireOn(manager: AutopilotManager): void {
  if (manager.snapshot().enabled) return;
  throw new PaneError('AUTOPILOT_OFF', 'Autopilot is off. Nothing was read or changed.', 'Turn it on in Settings › Advanced › Experimental › Autopilot.');
}

/**
 * D-66, enforced in the control plane: every route by which an answer reaches an agent refuses
 * Autopilot. The person's own UI sends no caller and is never refused.
 */
export function refuseAnswers(manager: Pick<AutopilotManager, 'isAutopilotCaller' | 'refuseAnswerFrom'>, notify: Pick<NotifyService, 'queue'>, channel: string, args: readonly PaneCommandValue[], caller: PaneDaemonCaller | undefined): void {
  if (!manager.isAutopilotCaller(caller)) return;
  switch (channel) {
    case 'notify:remote-command': {
      const type = decodeBoundary(args[0] ?? {}, remoteCommandTypeSchema).type;
      if (type === 'answer' || type === 'undo') manager.refuseAnswerFrom(caller, 'an approval or question');
      // Hiding, skipping or snoozing a card takes it from the person, which is just as much theirs.
      if (type === 'dismiss' || type === 'skip' || type === 'remind') manager.refuseAnswerFrom(caller, 'an approval or question (hiding or putting off its card)');
      return;
    }
    case 'permission:respond':
      manager.refuseAnswerFrom(caller, 'a permission prompt');
      return;
    case 'chat-tab:permission':
    case 'chat-tab:answer':
      // Its own tab's questions are the person's to answer in its chat; another tab's are never Autopilot's.
      if (args[0] !== caller?.panelId) manager.refuseAnswerFrom(caller, channel === 'chat-tab:permission' ? 'a chat tab\'s permission prompt' : 'a chat tab\'s question');
      return;
    case 'runpane:panels:input':
    case 'terminal:input':
    case 'terminal:paste-file':
    case 'terminal:paste-image':
    case 'panels:send-input':
    case 'panels:send-terminal-input':
    case 'sessions:input':
    case 'sessions:send-terminal-input':
      // Raw keys are how a terminal prompt gets answered; Autopilot has no other use for them.
      manager.refuseAnswerFrom(caller, 'a terminal prompt (raw input)');
      return;
    case 'runpane:panels:submit':
    case 'runpane:panels:submit-composer': {
      const target = decodeBoundary(args[0] ?? {}, boundary.object({ panelId: boundary.optional(boundary.string) })).panelId;
      const prompt = target ? notify.queue.waitingItems().find(item => item.agentPrompt && item.source.panelId === target) : undefined;
      if (prompt) manager.refuseAnswerFrom(caller, `the permission prompt "${prompt.title}" by typing into its tab`);
      return;
    }
    default:
  }
}

/** Files linked from items still waiting on the person (or held for Undo): their cards open them. */
function itemLinkPaths(notify: Pick<NotifyService, 'queue'>): string[] {
  return notify.queue.snapshot().items
    .filter(item => item.state === 'waiting' || item.state === 'sent')
    .flatMap(item => (item.links ?? []).flatMap(link => 'path' in link ? [link.path] : []));
}

export function readDocument(manager: Pick<AutopilotManager, 'snapshot'>, file: string, options: { inline?: boolean; links?: () => string[] } = {}): AutopilotDocument {
  const { stack, run } = manager.snapshot();
  // Only documents something put on the stack, the run's own docs, or a waiting item's links open here.
  const known = stack.entries.some(entry => entry.tabs.some(tab => tab.kind === 'file' && tab.path === file))
    || (!!run && !path.relative(run.folder, file).startsWith('..'))
    || (options.links?.() ?? []).includes(file);
  if (!known) return { kind: 'missing', path: file, message: 'This file is not on Autopilot\'s stack.' };
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { kind: 'missing', path: file, message: `There is no file at ${file} any more.` }; }
  if (!stat.isFile()) return { kind: 'missing', path: file, message: `${file} is not a file.` };
  const html = /\.html?$/i.test(file);
  if (html && !options.inline) return { kind: 'html', url: pathToFileURL(file).toString(), path: file };
  if (stat.size > TEXT_LIMIT_BYTES) return { kind: 'missing', path: file, message: `${path.basename(file)} is larger than 2 MiB; open it in Pane instead.` };
  const text = fs.readFileSync(file, 'utf8');
  if (html) return { kind: 'html', url: pathToFileURL(file).toString(), path: file, html: text };
  return { kind: 'text', text, path: file };
}
