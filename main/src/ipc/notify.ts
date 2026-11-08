import { ChatTabNotifyBridge } from '../services/chatTabs/notifyBridge';
import { getChatTabManager, setChatTabNotify } from '../services/chatTabs';
import { app, BrowserWindow, powerMonitor, type IpcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import type { AppServices } from './types';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { paneCommandSignal, teammatePaneCaller } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { getPaneEventSink } from '../core/runtime';
import { hasHeadlessDaemonLaunchArg } from '../utils/runtimeMode';
import { getMobilePushSender } from '../daemon/mobilePushSender';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { submitOnlyToAgent } from './runpane';
import { NotifyService } from '../services/notify/notifyService';
import { ASKING_TAB_CLOSED } from '../services/notify/notifyQueue';
import { ClaudePromptBridge } from '../services/claudePrompts/claudePromptBridge';
import { setClaudePromptBridge } from '../services/claudePrompts';
import type { MachineConnections } from '../services/machineConnections';
import { LOCAL_MACHINE_ID, type MachineState } from '../../../shared/types/machineConnections';
import { buildWindowAppearanceOptions } from '../services/appearanceService';
import { normalizeAppearance } from '../../../shared/types/appearance';
import { PaneError, paneErrorText } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { NOTIFY_LINK_LABEL_MAX, NOTIFY_LINKS_MAX, NOTIFY_QUESTIONS_MAX, type NotifyCommand, type NotifyItem, type NotifyLink, type NotifyQuestion, type NotifyRemoteCommand, type NotifyRequest, type NotifyResult, type NotifySession, type NotifySharedState } from '../../../shared/types/notify';
import type { RunpaneInboxItem } from '../../../shared/types/runpaneOrchestration';
import type { SessionInboxEnded } from '../services/sessionInbox';
import { thisMachineName, type ApprovalStore } from '../services/approvals/approvalStore';
import type { JsonStoreImportOutcome } from '../database/jsonStoreImport';
import type { AgentState } from '../../../shared/types/agentStatus';
import { paneSecretNameProblem, paneSecretProjectProblem, teammateSecretRefusal } from '../../../shared/types/paneSecrets';
import { paneSecretStore } from '../services/paneSecrets';

const MAX_CHOICES = 9;
const MAX_TEXT = 4_000;
const MAX_DETAIL = 20_000;
const MAX_DETAIL_LABEL = 40;

/** A related link as an agent sends it: checked further in parseLinks. */
const linkInputSchema = boundary.object({
  label: boundary.string,
  path: boundary.optional(boundary.string),
  url: boundary.optional(boundary.string),
  approval: boundary.optional(boundary.string),
});
const linkSchema = boundary.union(
  boundary.object({ label: boundary.nonEmptyString, path: boundary.nonEmptyString }),
  boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString }),
  boundary.object({ label: boundary.nonEmptyString, approval: boundary.nonEmptyString }),
);
const choiceSchema = boundary.object({
  label: boundary.nonEmptyString,
  detail: boundary.optional(boundary.string),
  recommended: boundary.optional(boundary.boolean),
  was: boundary.optional(boundary.string),
});
const subQuestionSchema = boundary.object({ title: boundary.string, choices: boundary.array(choiceSchema) });
const sessionSchema = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.string,
  paneId: boundary.string,
  orchestrator: boundary.optional(boundary.boolean),
});

const notifyRequestSchema = boundary.object({
  ui: boundary.optional(boundary.enumeration('options', 'approve', 'ask', 'secret', 'info')),
  title: boundary.optional(boundary.string),
  context: boundary.optional(boundary.string),
  choices: boundary.optional(boundary.array(choiceSchema)),
  questions: boundary.optional(boundary.array(subQuestionSchema)),
  detail: boundary.optional(boundary.string),
  detailLabel: boundary.optional(boundary.string),
  suggestions: boundary.optional(boundary.array(boundary.string)),
  action: boundary.optional(boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString })),
  secret: boundary.optional(boundary.object({ project: boundary.string, name: boundary.string })),
  links: boundary.optional(boundary.array(linkInputSchema)),
  resume: boundary.optional(boundary.nonEmptyString),
  took: boundary.optional(boundary.string),
  tookAs: boundary.optional(boundary.enumeration('answer', 'question')),
  status: boundary.optional(boundary.string),
  update: boundary.optional(boundary.string),
  asked: boundary.optional(boundary.string),
  whatChanged: boundary.optional(boundary.string),
  relays: boundary.optional(boundary.nonEmptyString),
  aboutSession: boundary.optional(boundary.nonEmptyString),
  returnAfterMs: boundary.optional(boundary.number),
  caller: boundary.object({
    paneId: boundary.optional(boundary.string),
    panelId: boundary.optional(boundary.string),
    cwd: boundary.optional(boundary.string),
    agent: boundary.optional(boundary.string),
  }),
});

const answerSchema = boundary.union(
  boundary.object({ picks: boundary.array(boundary.string), text: boundary.optional(boundary.string) }),
  boundary.object({ choice: boundary.nonEmptyString, note: boundary.optional(boundary.string) }),
  boundary.object({ approved: boundary.boolean, note: boundary.optional(boundary.string) }),
  boundary.object({ text: boundary.string }),
);
const idCommand = <const T extends string>(type: T) => boundary.object({ type: boundary.literal(type), id: boundary.nonEmptyString });
const notifyCommandSchema = boundary.union(
  boundary.object({ type: boundary.literal('answer'), id: boundary.nonEmptyString, answer: answerSchema }),
  idCommand('undo'),
  idCommand('dismiss'),
  idCommand('skip'),
  idCommand('open-in-pane'),
  boundary.object({ type: boundary.literal('open-link'), id: boundary.nonEmptyString, index: boundary.number, paneId: boundary.optional(boundary.nonEmptyString) }),
  boundary.object({ type: boundary.literal('remind'), id: boundary.nonEmptyString, after: boundary.enumeration('3m', '5m', '15m', '10m', '1h', 'pane') }),
  boundary.object({ type: boundary.literal('hover-info'), id: boundary.nonEmptyString, hovering: boundary.boolean }),
  boundary.object({ type: boundary.literal('pause'), minutes: boundary.number }),
  boundary.object({ type: boundary.literal('resume') }),
  boundary.object({ type: boundary.literal('open-round'), id: boundary.optional(boundary.nonEmptyString) }),
  boundary.object({ type: boundary.literal('close-round') }),
  boundary.object({ type: boundary.literal('open-inbox') }),
  boundary.object({ type: boundary.literal('show-details'), shown: boundary.boolean }),
  boundary.object({ type: boundary.literal('close'), id: boundary.nonEmptyString, reason: boundary.optional(boundary.string) }),
  idCommand('reopen'),
  boundary.object({ type: boundary.literal('override'), id: boundary.nonEmptyString, answer: answerSchema }),
  boundary.object({ type: boundary.literal('fix-reply'), id: boundary.nonEmptyString, as: boundary.enumeration('answer', 'question') }),
);
/** The question of Autopilot's rewrite: checked further in parseNotifyRequest. */
const rewriteQuestionSchema = boundary.object({
  ui: boundary.enumeration('options', 'approve', 'ask', 'info'),
  title: boundary.string,
  context: boundary.optional(boundary.string),
  choices: boundary.optional(boundary.array(choiceSchema)),
  questions: boundary.optional(boundary.array(subQuestionSchema)),
  detail: boundary.optional(boundary.string),
  detailLabel: boundary.optional(boundary.string),
  suggestions: boundary.optional(boundary.array(boundary.string)),
  links: boundary.optional(boundary.array(linkSchema)),
});
const notifyRemoteCommandSchema = boundary.union(
  boundary.object({ type: boundary.literal('answer'), id: boundary.nonEmptyString, answer: answerSchema }),
  boundary.object({ type: boundary.literal('open-link'), id: boundary.nonEmptyString, index: boundary.number, paneId: boundary.optional(boundary.nonEmptyString) }),
  idCommand('undo'),
  idCommand('dismiss'),
  idCommand('skip'),
  boundary.object({ type: boundary.literal('remind'), id: boundary.nonEmptyString, after: boundary.enumeration('3m', '5m', '15m', '10m', '1h') }),
  boundary.object({ type: boundary.literal('close'), id: boundary.nonEmptyString, reason: boundary.optional(boundary.string) }),
  idCommand('reopen'),
  boundary.object({ type: boundary.literal('override'), id: boundary.nonEmptyString, answer: answerSchema }),
  boundary.object({ type: boundary.literal('fix-reply'), id: boundary.nonEmptyString, as: boundary.enumeration('answer', 'question') }),
  boundary.object({ type: boundary.literal('agent-answer'), id: boundary.nonEmptyString, answer: answerSchema, because: boundary.nonEmptyString, machine: boundary.optional(boundary.string) }),
  boundary.object({ type: boundary.literal('agent-close'), id: boundary.nonEmptyString, reason: boundary.nonEmptyString, machine: boundary.optional(boundary.string) }),
  boundary.object({ type: boundary.literal('agent-rewrite'), id: boundary.nonEmptyString, question: rewriteQuestionSchema, reason: boundary.optional(boundary.string), machine: boundary.optional(boundary.string), newId: boundary.optional(boundary.nonEmptyString) }),
);
/** The server's name for the sender (httpApiServer fills it in), never the caller's own claim. */
const remoteSenderSchema = boundary.object({ device: boundary.nonEmptyString });
const actorSchema = boundary.enumeration('you', 'autopilot', 'orchestrator', 'pane');
const replySchema = boundary.object({
  id: boundary.nonEmptyString,
  text: boundary.string,
  picks: boundary.optional(boundary.array(boundary.string)),
  at: boundary.number,
  state: boundary.enumeration('reading', 'answer', 'question', 'unread', 'sent'),
  reader: boundary.optional(boundary.object({ kind: boundary.enumeration('asker', 'orchestrator', 'autopilot'), panelId: boundary.optional(boundary.string), name: boundary.string })),
  deliveredAt: boundary.optional(boundary.number),
  status: boundary.optional(boundary.string),
  fixed: boundary.optional(boundary.enumeration('answer', 'question')),
});
const revisionSchema = boundary.object({ asked: boundary.string, whatChanged: boundary.array(boundary.string), by: boundary.string, at: boundary.number });
const notifyItemSchema = boundary.object({
  id: boundary.nonEmptyString,
  ui: boundary.enumeration('options', 'approve', 'ask', 'secret', 'info'),
  title: boundary.string,
  context: boundary.optional(boundary.string),
  choices: boundary.optional(boundary.array(choiceSchema)),
  questions: boundary.optional(boundary.array(subQuestionSchema)),
  replyIsAnswer: boundary.optional(boundary.boolean),
  detail: boundary.optional(boundary.string),
  detailLabel: boundary.optional(boundary.string),
  suggestions: boundary.optional(boundary.array(boundary.string)),
  action: boundary.optional(boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString })),
  agentPrompt: boundary.optional(boundary.object({ yes: boundary.string, no: boundary.string, inTerminal: boundary.optional(boundary.boolean) })),
  secret: boundary.optional(boundary.object({ project: boundary.string, name: boundary.string, replaces: boundary.optional(boundary.boolean) })),
  secretError: boundary.optional(boundary.string),
  links: boundary.optional(boundary.array(linkSchema)),
  source: boundary.object({
    paneId: boundary.optional(boundary.string),
    panelId: boundary.optional(boundary.string),
    name: boundary.string,
    agent: boundary.string,
    project: boundary.optional(boundary.string),
    session: boundary.optional(sessionSchema),
    autopilot: boundary.optional(boundary.boolean),
  }),
  relay: boundary.optional(boundary.object({ inboxItemId: boundary.nonEmptyString, worker: boundary.string, question: boundary.string })),
  state: boundary.enumeration('waiting', 'sent', 'answered', 'expired', 'info'),
  createdAt: boundary.number,
  resolvedAt: boundary.optional(boundary.number),
  answerSummary: boundary.optional(boundary.string),
  answeredOn: boundary.optional(boundary.string),
  snoozedUntil: boundary.optional(boundary.number),
  originKind: boundary.optional(boundary.enumeration('orchestrator', 'worker', 'autopilot', 'claude-prompt', 'pane', 'agent')),
  connected: boundary.optional(boundary.union(
    boundary.object({ kind: boundary.literal('session'), id: boundary.string, name: boundary.string, paneId: boundary.string }),
    boundary.object({ kind: boundary.literal('pane'), id: boundary.string, name: boundary.string }),
    boundary.object({ kind: boundary.literal('autopilot'), id: boundary.literal('autopilot'), name: boundary.literal('Autopilot') }),
    boundary.object({ kind: boundary.literal('machine'), id: boundary.string, name: boundary.string }),
  )),
  answeredBy: boundary.optional(boundary.object({ by: actorSchema, because: boundary.optional(boundary.string) })),
  closed: boundary.optional(boundary.object({ by: actorSchema, reason: boundary.string, at: boundary.number })),
  staleSince: boundary.optional(boundary.number),
  quiet: boundary.optional(boundary.boolean),
  rewrittenFrom: boundary.optional(boundary.object({ id: boundary.string, title: boundary.string, qn: boundary.optional(boundary.string) })),
  rewrittenAs: boundary.optional(boundary.object({ id: boundary.string, title: boundary.string })),
  delivered: boundary.optional(boundary.object({ via: boundary.enumeration('call', 'tab'), at: boundary.number })),
  undelivered: boundary.optional(boundary.object({ reason: boundary.string, at: boundary.number })),
  decision: boundary.optional(boundary.string),
  corrections: boundary.optional(boundary.array(boundary.object({ summary: boundary.string, by: actorSchema, at: boundary.number }))),
  reopened: boundary.optional(boundary.object({ by: actorSchema, device: boundary.optional(boundary.string), at: boundary.number, closedBy: actorSchema, closedReason: boundary.string })),
  pushed: boundary.optional(boundary.boolean),
  summaryOf: boundary.optional(boundary.array(boundary.string)),
  reply: boundary.optional(replySchema),
  version: boundary.optional(boundary.number),
  revision: boundary.optional(revisionSchema),
  versions: boundary.optional(boundary.array(boundary.object({
    version: boundary.number,
    title: boundary.string,
    context: boundary.optional(boundary.string),
    choices: boundary.optional(boundary.array(choiceSchema)),
    questions: boundary.optional(boundary.array(subQuestionSchema)),
    links: boundary.optional(boundary.array(linkSchema)),
    at: boundary.number,
    revision: boundary.optional(revisionSchema),
  }))),
  readyAgain: boundary.optional(boundary.number),
  relayedBy: boundary.optional(boundary.object({ panelId: boundary.string, name: boundary.string })),
});
const notifySharedStateSchema = boundary.object({
  machine: boundary.string,
  epoch: boundary.string,
  revision: boundary.number,
  enabled: boundary.boolean,
  items: boundary.array(notifyItemSchema),
  queue: boundary.array(boundary.string),
  hidden: boundary.array(boundary.string),
});
const windowSizeSchema = boundary.object({ width: boundary.number, height: boundary.number });
const panelAgentSchema = boundary.object({ agentType: boundary.optional(boundary.string) });

/** What Notify reads from the app's services: the config, Panes by id, and the main window. */
type NotifyServices = Pick<AppServices, 'configManager' | 'getMainWindow'> & {
  sessionManager: Pick<AppServices['sessionManager'], 'getSession'> & Partial<Pick<AppServices['sessionManager'], 'on' | 'off'>>;
  databaseService?: Pick<AppServices['databaseService'], 'getAllProjects'> & Partial<Pick<AppServices['databaseService'], 'getSession' | 'getPanel'>>;
  /** Files each Approvals item under its Session. */
  orchestrationSessionManager?: {
    approvalSession(paneId: string, panelId?: string): NotifySession | undefined;
    approvalSessionsById(): Map<string, NotifySession>;
    approvalSessionRecord(sessionId: string): { name: string; paneId: string; archived: boolean } | undefined;
    on(event: 'changed', listener: () => void): void;
    off(event: 'changed', listener: () => void): void;
  };
  /** A worker's blocked report's question is an item. */
  sessionInbox?: { all(): RunpaneInboxItem[]; subscribe(listener: () => void): () => void; subscribeEnded(listener: (ended: SessionInboxEnded) => void): () => void; ack?(ids: readonly string[]): void };
  approvalStore?: ApprovalStore;
  approvalImport?: JsonStoreImportOutcome;
};

/** Seconds since this computer was used (D-144); QA's profiles on one Mac read theirs from a file (J33). */
function idleSeconds(): number {
  const testFile = process.env.PANE_TEST_IDLE_SECONDS_FILE;
  if (testFile) {
    const seconds = Number(fs.readFileSync(testFile, 'utf8'));
    return Number.isFinite(seconds) ? seconds : 0;
  }
  try {
    return powerMonitor.getSystemIdleState(1) === 'locked' ? Infinity : powerMonitor.getSystemIdleTime();
  } catch {
    // Before the app is ready, or where the OS won't say: don't silence anything.
    return 0;
  }
}

/**
 * Whether Pane may type an owed answer into a terminal tab: only at a live agent's prompt, with an
 * agent in the terminal's foreground process group (D-5). Typed at a shell, a nested shell, `ssh`
 * or a REPL, `$(…)` in an answer would run (QA N1).
 */
export function tabTakesText(status: AgentState | undefined, agentInForeground: boolean): boolean {
  return status === 'idle' && agentInForeground;
}

/** Why an item's Pane or tab can no longer take an answer. Read from the database, which is whole from the first moment of a start. */
function askerPaneGone(database: NotifyServices['databaseService'], item: NotifyItem): string | undefined {
  const { paneId, panelId } = item.source;
  if (paneId && database?.getSession) {
    const pane = database.getSession(paneId);
    if (!pane) return 'Pane deleted';
    if (pane.archived) return 'Pane archived';
  }
  if (panelId && database?.getPanel && !database.getPanel(panelId)) return ASKING_TAB_CLOSED;
  return undefined;
}

export function registerNotifyHandlers(ipcMain: IpcMain, services: NotifyServices, commandRegistry: PaneCommandRegistry): NotifyService {
  const notify = new NotifyService({
    configManager: services.configManager,
    getMainWindow: services.getMainWindow,
    findPane: (caller) => {
      const panel = caller.panelId ? panelManager.getPanel(caller.panelId) : undefined;
      const paneId = caller.paneId || panel?.sessionId;
      const pane = paneId ? services.sessionManager.getSession(paneId) : undefined;
      // The same ownership rule as `runpane report` and locks: the panel must belong to the Pane.
      if (!pane || pane.archived || (panel && panel.sessionId !== pane.id)) return undefined;
      const agentType = decodeOptionalBoundary(panel?.state.customState, panelAgentSchema)?.agentType;
      return { paneId: pane.id, panelId: panel?.id, name: pane.name, agentType };
    },
    openLink: async (paneId, link) => {
      // Another approval opens in place on the card, never as a tab.
      if ('approval' in link) throw new PaneError('ERR_APPROVALS_LINK_OPEN', `${link.label} is another approval, which opens on the card itself. Nothing was opened.`, 'Open it from its tab on the approval.');
      // A file page is titled by its label, as the card shows it.
      const target = 'path' in link ? { filePath: link.path } : link.url.startsWith('file:') ? { url: link.url, title: link.label } : { url: link.url };
      await commandRegistry.invoke('runpane:panels:open', [{ paneId, ...target, placement: 'tab', source: 'user' }]);
    },
    rendererArguments: () => buildWindowAppearanceOptions(normalizeAppearance(services.configManager.getConfig()).appearance, false, {}).additionalArguments,
    headless: hasHeadlessDaemonLaunchArg(),
    machine: thisMachineName(),
    secrets: {
      exists: (project, name) => paneSecretStore().has(project, name),
      save: async (project, name, value) => { await paneSecretStore().set(project, name, value); },
    },
    publish: (state) => getPaneEventSink().send('notify:shared-changed', state),
    sendToMachine: async (machineId, command) => {
      if (!saved) throw new PaneError('ERR_MACHINE_UNKNOWN', 'Pane is still starting its machine connections. Nothing was sent.', 'Answer again in a moment.');
      const { machines } = saved;
      const send = () => machines.run(machineId, { type: 'notify', command });
      try {
        await send();
      } catch (error) {
        // While a machine connects, its questions already show but commands wait.
        // ERR_MACHINE_OFFLINE means nothing was sent, so the answer goes once it is connected.
        if (!(error instanceof PaneError && error.code === 'ERR_MACHINE_OFFLINE') || !(await saved.onlineSoon(machineId))) throw error;
        await send();
      }
    },
    refreshMachine: (machineId) => saved?.read(machineId) ?? Promise.resolve(),
    // Every question buzzes each phone with Needs Input on (D-7), on a desktop or a headless host.
    onQuestion: (event) => {
      // Optional delivery: a failed send or config write must never take the host down.
      getMobilePushSender(services.configManager).observeQuestion(event).catch((error: Error) => {
        console.warn('[Notify] The phone alert for a question was not sent:', error);
      });
    },
    wslDistros: () => (services.databaseService?.getAllProjects() ?? [])
      .flatMap(project => project.wsl_enabled && project.wsl_distribution ? [project.wsl_distribution] : []),
    sessionOf: (paneId, panelId) => services.orchestrationSessionManager?.approvalSession(paneId, panelId),
    projectOf: (paneId) => {
      const projectId = services.databaseService?.getSession?.(paneId)?.project_id;
      return projectId === undefined || projectId === null ? undefined : services.databaseService?.getAllProjects().find(project => project.id === projectId)?.name;
    },
    sessionsById: () => services.orchestrationSessionManager?.approvalSessionsById() ?? new Map(),
    sessionRecord: services.orchestrationSessionManager ? (sessionId) => services.orchestrationSessionManager?.approvalSessionRecord(sessionId) : undefined,
    onSessionsChanged: (listener) => {
      const sessions = services.orchestrationSessionManager;
      sessions?.on('changed', listener);
      return () => { sessions?.off('changed', listener); };
    },
    inbox: services.sessionInbox,
    store: services.approvalStore,
    importOutcome: services.approvalImport,
    askerPaneGone: (item) => askerPaneGone(services.databaseService, item),
    onAskersChanged: (listener) => {
      const stopPanels = panelManager.onPanelDeleted?.(listener);
      const manager = services.sessionManager;
      manager.on?.('session-deleted', listener);
      manager.on?.('session-updated', listener);
      return () => {
        stopPanels?.();
        manager.off?.('session-deleted', listener);
        manager.off?.('session-updated', listener);
      };
    },
    typeIntoTab: async (panelId, text) => {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return 'gone';
      if (panel.type === 'chat') {
        if (getChatTabManager().agentState(panelId) !== 'idle') return 'busy';
      } else {
        // The status is free to read; the process group costs a `ps`, so only an idle tab pays for it.
        const status = terminalPanelManager.getAgentStatus(panelId);
        if (status !== 'idle') return 'busy';
        const agentInForeground = await terminalPanelManager.readForegroundAgent(panelId);
        // Where Pane can't see what runs in the tab (Windows, WSL, the PTY host), it never types (F-7).
        if (agentInForeground === undefined) return 'unsupported';
        if (!tabTakesText(status, agentInForeground)) return 'busy';
      }
      try {
        const submit = () => commandRegistry.invoke('runpane:panels:submit', [{ panelId, input: text, expectReport: false }]);
        const result = decodeOptionalBoundary(await (panel.type === 'chat' ? submit() : submitOnlyToAgent(panelId, submit)), boundary.object({ ok: boundary.optional(boundary.boolean) }));
        return result?.ok === false ? 'busy' : 'delivered';
      } catch (error) {
        // Not started yet, say: the next time it's at its prompt, or the next sweep, tries again.
        console.warn(`[Notify] Couldn't type into tab ${panelId} yet:`, error);
        return 'busy';
      }
    },
    idleSeconds: () => (hasHeadlessDaemonLaunchArg() ? Infinity : idleSeconds()),
    tabAlive: (panelId) => panelManager.getPanel(panelId) !== undefined,
  });

  notifyBeforeQuit = () => notify.queue.prepareForQuit();

  /** Set once the machine connections start: every saved machine's questions then show here. */
  let saved: SavedMachinesLink | null = null;
  followMachines = (machines) => { saved = linkSavedMachines(notify, machines); };

  // Open in Pane works for the machine the app is on; another machine's card would need a switch.
  const showActiveMachine = () => {
    const state = remotePaneClientController.getConnectionState();
    notify.queue.setActiveMachine(state.mode === 'remote' && state.activeProfileId ? state.activeProfileId : LOCAL_MACHINE_ID);
  };
  remotePaneClientController.on('state-changed', showActiveMachine);
  showActiveMachine();

  commandRegistry.register('runpane:notify', async (request: PaneCommandValue): Promise<NotifyResult> => {
    const parsed = parseNotifyRequest(request);
    const teammate = teammatePaneCaller();
    // A secret card writes the owner's secret store, so a teammate cannot post one.
    if (teammate && parsed.ui === 'secret') throw teammateSecretRefusal(teammate, 'ask for a secret');
    return notify.ask(parsed, paneCommandSignal());
  });

  commandRegistry.register('notify:remote-snapshot', async () => notify.sharedState());
  commandRegistry.register('notify:remote-command', async (command: PaneCommandValue, sender: PaneCommandValue) => {
    // A Mac names itself "studio.local" on its event stream; cards call it "studio".
    const device = decodeBoundary(sender, remoteSenderSchema).device.replace(/\.(local|lan|home|internal)$/i, '');
    const decoded: NotifyRemoteCommand = decodeBoundary(command, notifyRemoteCommandSchema);
    // A forwarded rewrite takes the same checks here, on the machine that holds the item (F-8).
    const rawQuestion = decodeBoundary(command, boundary.object({ question: boundary.optional(boundary.jsonObject) })).question;
    const checked = decoded.type === 'agent-rewrite' && rawQuestion ? { ...decoded, question: parseRewriteQuestion(rawQuestion) } : decoded;
    await notify.runRemote(checked, device, teammatePaneCaller());
    return null;
  });

  ipcMain.handle('notify:snapshot', () => notify.snapshot());
  ipcMain.handle('notify:command', async (_event, command: PaneCommandValue) => {
    try {
      await notify.run(decodeBoundary(command, notifyCommandSchema) satisfies NotifyCommand);
    } catch (error) {
      // Electron passes only "PaneError: <message>" to the renderer: keep the next step in the text it shows.
      throw error instanceof PaneError ? new Error(paneErrorText(error)) : error;
    }
  });
  ipcMain.on('notify:window-size', (event, size: PaneCommandValue) => notify.resizeWindow(event.sender, decodeBoundary(size, windowSizeSchema)));
  ipcMain.handle('notify:window-focus', (event) => notify.focusWindow(event.sender));

  app.on('browser-window-focus', (_event, window: BrowserWindow) => {
    if (window === services.getMainWindow()) notify.setMainWindowFocused(true);
  });
  app.on('browser-window-blur', (_event, window: BrowserWindow) => {
    if (window === services.getMainWindow()) notify.setMainWindowFocused(false);
  });
  // Codex 0.164's Esc drops the call without telling the server: a Codex panel idle at its prompt
  // with a call still open has stopped waiting. Other clients cancel the call themselves, and a
  // shell running `runpane notify` reads as idle while it waits, so only Codex panels count.
  terminalPanelManager.on('agent-status', (change: { panelId: string; state: AgentState }) => {
    const agentType = decodeOptionalBoundary(panelManager.getPanel(change.panelId)?.state.customState, panelAgentSchema)?.agentType;
    if (agentType === 'codex') notify.queue.panelStatus(change.panelId, change.state === 'idle');
    // A tab back at its prompt can take what's owed to it.
    if (change.state === 'idle') notify.queue.flushTabMessages();
  });
  terminalPanelManager.on('pause-changed', (change: { panelIds: string[]; paused: boolean }) => {
    if (change.paused) notify.queue.withdrawForPanels(change.panelIds);
  });
  app.on('browser-window-created', (_event, window: BrowserWindow) => {
    window.on('closed', () => notify.closeFloatingWindowsIfAlone());
  });
  for (const window of BrowserWindow.getAllWindows()) window.on('closed', () => notify.closeFloatingWindowsIfAlone());
  app.on('will-quit', () => notify.dispose());
  startClaudePrompts(notify, services);
  startChatTabPrompts(notify, services);
  return notify;
}

/** Chat tabs ask their approvals and single-choice questions in Notify too; the first answer wins. */
function startChatTabPrompts(notify: NotifyService, services: NotifyServices): void {
  const { configManager } = services;
  const bridge = new ChatTabNotifyBridge({
    queue: notify.queue,
    source: panelId => {
      const panel = panelManager.getPanel(panelId);
      const pane = panel ? services.sessionManager.getSession(panel.sessionId) : undefined;
      if (!panel || panel.type !== 'chat' || !pane || pane.archived) return undefined;
      const agent = getChatTabManager().view(panelId, 0, false).agent;
      return { paneId: pane.id, panelId, name: pane.name, agent: agent === 'claude' ? 'Claude' : 'Codex' };
    },
    enabled: () => configManager.getConfig().answerPromptsFromPane !== false,
    answerPermission: (panelId, requestId, optionId) => getChatTabManager().answerPermission(panelId, requestId, optionId),
    answerQuestion: (panelId, questionId, answer) => getChatTabManager().answerQuestion(panelId, questionId, answer),
  });
  setChatTabNotify(bridge);
  app.on('will-quit', () => setChatTabNotify(undefined));
}

/** Seconds Claude holds a prompt's hook before it stops waiting on Pane; tests shorten it. */
const CLAUDE_PROMPT_TIMEOUT_SECONDS = Number(process.env.PANE_CLAUDE_PROMPT_TIMEOUT_SECONDS) || 600;

/** Claude tabs Pane starts ask their permission and plan prompts here too (Settings → AI agents). */
function startClaudePrompts(notify: NotifyService, services: NotifyServices): void {
  const { configManager } = services;
  const bridge = new ClaudePromptBridge({
    queue: notify.queue,
    tab: (panelId) => {
      const panel = panelManager.getPanel(panelId);
      const pane = panel ? services.sessionManager.getSession(panel.sessionId) : undefined;
      if (!panel || !pane || pane.archived) return undefined;
      // Claude keeps a worktree's "don't ask again" rules in its repository, which is the Pane project.
      const project = services.databaseService?.getAllProjects().find(candidate => candidate.id === pane.projectId)?.name;
      return { source: { paneId: pane.id, panelId, name: pane.name, agent: 'Claude' }, project };
    },
    enabled: () => configManager.getConfig().answerPromptsFromPane !== false,
    hookTimeoutSeconds: CLAUDE_PROMPT_TIMEOUT_SECONDS,
    onPrompt: () => {
      // The switch starts on for everyone (D-120), so the first prompt says where it came from once.
      if (configManager.getConfig().claudePromptsNoteShown) return;
      void configManager.updateConfig({ claudePromptsNoteShown: true });
      void notify.queue.ask({
        question: {
          ui: 'info',
          title: "Claude's prompts now show here",
          context: 'Pane asks the permission and plan prompts of the Claude tabs it starts in Notify and on your phone. The terminal still asks too; the first answer wins. Turn it off in Settings → AI agents → Answer prompts from Pane.',
        },
        source: { name: 'Pane', agent: 'Pane' },
      });
    },
  });
  terminalPanelManager.on('agent-status', (change: { panelId: string; state: AgentState }) => bridge.panelStatus(change.panelId, change.state));
  // Off takes effect at once: prompts already in Notify go back to the terminal alone.
  configManager.on('config-updated', (config: { answerPromptsFromPane?: boolean }) => {
    if (config.answerPromptsFromPane === false) bridge.releaseAll();
  });
  bridge.start().then(() => setClaudePromptBridge(bridge)).catch((error: Error) => {
    console.warn("[Claude prompts] Pane couldn't listen for Claude's prompts; they stay in the terminal:", error);
  });
  app.on('will-quit', () => {
    setClaudePromptBridge(undefined);
    void bridge.stop();
  });
}

/** What Notify uses of the machine connections (main/src/services/machineConnections.ts). */
export type NotifyMachines = Pick<MachineConnections, 'subscribe' | 'list' | 'read' | 'run'>;

interface SavedMachinesLink {
  machines: NotifyMachines;
  /** Reads one saved machine's questions again. */
  read: (machineId: string) => Promise<void>;
  /** Waits up to 15 s for a machine that is still connecting to answer; false if it isn't connecting or doesn't. */
  onlineSoon: (machineId: string) => Promise<boolean>;
}

let followMachines: ((machines: NotifyMachines) => void) | null = null;
let notifyBeforeQuit: (() => void) | null = null;

/** Call just before stopping the daemon server: its calls ending isn't their askers leaving (J6). */
export function prepareNotifyForQuit(): void {
  notifyBeforeQuit?.();
}

/**
 * Shows every saved machine's questions beside this computer's, in any mode, each slot fed by
 * that machine's own connection, for as long as the connections run. Call after `registerNotifyHandlers`.
 */
export function followSavedMachines(machines: NotifyMachines): void {
  followMachines?.(machines);
}

/** One Notify slot per saved machine: read on first sight, on reconnect and resync; kept, unanswerable, while offline. */
function linkSavedMachines(notify: NotifyService, machines: NotifyMachines): SavedMachinesLink {
  const queue = notify.queue;
  const known = new Map<string, MachineState>();
  /** `state` is undefined when the machine sent a Notify state this Pane cannot read. */
  const show = (machineId: string, state: NotifySharedState | undefined) => {
    const machine = known.get(machineId);
    if (!machine) return;
    if (!state) {
      console.warn(`[Notify] ${machine.label} sent a Notify state this Pane cannot read; its questions are not shown here.`);
      return;
    }
    // A read finishing after the machine went offline must not mark its cards answerable again.
    queue.setRemote(machineId, { machine: machine.label, online: machine.status !== 'offline', state });
  };
  const read = async (machineId: string) => {
    if (!known.has(machineId)) return;
    try {
      show(machineId, decodeOptionalBoundary((await machines.read(machineId, 'notify:remote-snapshot')).data, notifySharedStateSchema));
    } catch (error) {
      // An older machine has no remote Notify, and one that is off can't answer; its questions stay on its own screen.
      console.warn(`[Notify] Could not read ${known.get(machineId)?.label ?? machineId}'s questions:`, error);
    }
  };
  const apply = (list: MachineState[]) => {
    const listed = new Set<string>();
    for (const machine of list) {
      if (machine.kind === 'local') continue;
      listed.add(machine.id);
      const before = known.get(machine.id);
      known.set(machine.id, { ...machine });
      if (machine.status === 'offline') queue.setRemote(machine.id, { machine: machine.label, online: false });
      // A stream can recover without a resync here yet: read the machine again.
      else if (!before || (machine.status === 'online' && before.status !== 'online')) void read(machine.id);
      else if (before.label !== machine.label) queue.setRemote(machine.id, { machine: machine.label, online: true });
    }
    for (const id of [...known.keys()]) {
      if (listed.has(id)) continue;
      known.delete(id);
      queue.setRemote(id, null);
    }
  };
  machines.subscribe((event) => {
    if (event.type === 'machines') apply(event.machines);
    // This computer's own questions are already in the queue.
    else if (event.machineId === LOCAL_MACHINE_ID) return;
    else if (event.type === 'resync') void read(event.machineId);
    else if (event.channel === 'notify:shared-changed') show(event.machineId, decodeOptionalBoundary(event.args[0], notifySharedStateSchema));
  });
  apply(machines.list());
  return {
    machines,
    read,
    onlineSoon: (machineId) => new Promise<boolean>((resolve) => {
      if (known.get(machineId)?.status !== 'connecting') {
        resolve(false);
        return;
      }
      let stopWaiting: () => void = () => undefined;
      const timer = setTimeout(() => done(false), 15_000);
      const done = (online: boolean) => {
        clearTimeout(timer);
        stopWaiting();
        resolve(online);
      };
      stopWaiting = machines.subscribe((event) => {
        if (event.type !== 'machines') return;
        const status = event.machines.find(machine => machine.id === machineId)?.status;
        if (status === 'online') done(true);
        else if (status !== 'connecting') done(false);
      });
    }),
  };
}

/** Checks a notify call the way the tool's schema promises, naming the field that's wrong. */
function parseNotifyRequest(value: PaneCommandValue): NotifyRequest {
  let decoded: ReturnType<typeof notifyRequestSchema.decode>;
  try {
    decoded = decodeBoundary(value, notifyRequestSchema);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  const { links, ...rest } = decoded;
  const request: NotifyRequest = rest;
  if (request.resume) return request;
  if (request.took !== undefined) {
    if (!request.took.trim()) throw invalid('took needs the approval\'s id or Q-n.');
    if (!request.tookAs) throw invalid('took needs answer or question: --took <id|Q-n> answer.');
    if (request.ui !== undefined || request.update !== undefined) throw invalid('took goes on its own, without ui or update.');
    return request;
  }
  if (request.tookAs !== undefined || request.status !== undefined) throw invalid('answer, question and status only go with took.');
  if (request.update !== undefined) {
    if (!request.update.trim()) throw invalid('update needs the approval\'s id or Q-n.');
    if (request.ui !== undefined) throw invalid('update keeps the approval\'s ui; leave ui out.');
    if (!request.asked?.trim()) throw invalid('update needs asked: the person\'s question, as they asked it.');
    if (!request.whatChanged?.trim()) throw invalid('update needs whatChanged: one line per change.');
    if ((request.title?.length ?? 0) > MAX_TEXT || (request.context?.length ?? 0) > MAX_TEXT || request.asked.length > MAX_TEXT || request.whatChanged.length > MAX_TEXT) throw invalid(`title, context, asked and whatChanged take up to ${MAX_TEXT} characters.`);
    if (request.choices && request.questions) throw invalid('pass choices or questions, not both.');
    if (request.choices) checkChoices(request.choices, 'choices');
    if (request.questions) checkQuestions(request.questions);
    if (links !== undefined) request.links = parseLinks(links, request.caller.cwd);
    return request;
  }
  if (request.asked !== undefined || request.whatChanged !== undefined) throw invalid('asked and whatChanged only go with update.');
  const { ui } = request;
  if (!ui) throw invalid('ui is required: options, approve, ask or info.');
  if (ui === 'secret') {
    // Created only by `runpane secrets request`, which names where the value is saved.
    if (!request.secret) throw invalid('secret is required for ui: secret: the project and name the value is saved as.');
    const problem = paneSecretProjectProblem(request.secret.project) ?? paneSecretNameProblem(request.secret.name);
    if (problem) throw invalid(problem);
  } else if (request.secret) {
    throw invalid(`secret only goes with ui: secret, not ${ui}.`);
  }
  if (!request.title?.trim()) throw invalid('title is required.');
  if (request.title.length > MAX_TEXT || (request.context?.length ?? 0) > MAX_TEXT) throw invalid(`title and context take up to ${MAX_TEXT} characters.`);
  if ((request.detail?.length ?? 0) > MAX_DETAIL) throw invalid(`detail takes up to ${MAX_DETAIL} characters.`);
  if (ui === 'options' && request.questions) {
    if (request.choices) throw invalid('pass choices or questions, not both.');
    checkQuestions(request.questions);
  } else if (ui === 'options') {
    checkChoices(request.choices ?? [], 'choices');
  } else if (request.choices || request.questions) {
    throw invalid(`${request.choices ? 'choices' : 'questions'} only goes with ui: options, not ${ui}.`);
  }
  if (request.choices?.some(choice => choice.was !== undefined)) throw invalid('was only goes with update: it names a reworded choice\'s old label.');
  if (request.detail !== undefined && ui !== 'approve') throw invalid(`detail only goes with ui: approve, not ${ui}.`);
  if (request.detailLabel !== undefined && request.detail === undefined) throw invalid('detailLabel needs detail: it labels the button that shows it.');
  // Code points, as the CLIs count them.
  if ([...request.detailLabel ?? ''].length > MAX_DETAIL_LABEL) throw invalid(`detailLabel takes up to ${MAX_DETAIL_LABEL} characters.`);
  if (request.suggestions !== undefined && ui !== 'ask') throw invalid(`suggestions only goes with ui: ask, not ${ui}.`);
  if (request.action !== undefined && ui !== 'info') throw invalid(`action only goes with ui: info, not ${ui}.`);
  if (request.action && !/^https?:\/\//i.test(request.action.url)) throw invalid('action.url must be an http(s) URL.');
  if (links !== undefined) request.links = parseLinks(links, request.caller.cwd);
  return request;
}

/** 1 to 9 choices with different labels. */
function checkChoices(choices: NonNullable<NotifyRequest['choices']>, where: string): void {
  const count = choices.length;
  if (count < 1 || count > MAX_CHOICES) throw invalid(`${where} needs 1 to ${MAX_CHOICES} entries for an options question; it has ${count}.`);
  if (new Set(choices.map(choice => choice.label.trim())).size !== count) throw invalid(`${where} need different labels.`);
}

/** 2 to 4 questions, each with a title and its own choices. */
function checkQuestions(questions: NonNullable<NotifyRequest['questions']>): void {
  if (questions.length < 2 || questions.length > NOTIFY_QUESTIONS_MAX) throw invalid(`questions takes 2 to ${NOTIFY_QUESTIONS_MAX} questions; it has ${questions.length}. For one, use choices.`);
  questions.forEach((question, index) => {
    if (!question.title.trim()) throw invalid(`questions[${index}].title is required.`);
    if (question.title.length > MAX_TEXT) throw invalid(`questions[${index}].title takes up to ${MAX_TEXT} characters.`);
    checkChoices(question.choices, `questions[${index}].choices`);
  });
}

/** Autopilot's rewrite takes the same checks as any notify call. */
export function parseRewriteQuestion(value: PaneCommandValue, cwd?: string): NotifyQuestion {
  const { caller: _caller, resume: _resume, relays: _relays, aboutSession: _about, returnAfterMs: _after, took: _took, tookAs: _tookAs, status: _status, update: _update, asked: _asked, whatChanged: _changed, ...question } = parseNotifyRequest({ ...decodeBoundary(value, boundary.jsonObject), caller: { cwd } });
  if (!question.ui || !question.title) throw invalid('ui and title are required.');
  return { ...question, ui: question.ui, title: question.title };
}

/**
 * Related links: up to 6, each a label and exactly one of a file path (relative to the asking
 * folder) or an http(s) URL.
 */
function parseLinks(links: Array<{ label: string; path?: string; url?: string; approval?: string }>, cwd: string | undefined): NotifyLink[] {
  if (links.length > NOTIFY_LINKS_MAX) throw invalid(`links takes up to ${NOTIFY_LINKS_MAX} entries; it has ${links.length}.`);
  return links.map((link, index): NotifyLink => {
    const label = link.label.trim();
    const where = `links[${index}]`;
    if (!label) throw invalid(`${where}.label is required.`);
    if ([...label].length > NOTIFY_LINK_LABEL_MAX) throw invalid(`${where}.label takes up to ${NOTIFY_LINK_LABEL_MAX} characters.`);
    const filePath = link.path?.trim();
    const url = link.url?.trim();
    const approval = link.approval?.trim();
    if ([filePath, url, approval].filter(Boolean).length !== 1) throw invalid(`${where} needs exactly one of path, url or approval.`);
    if (approval) return { label, approval };
    if (url) {
      if (!/^https?:\/\/\S+$/i.test(url)) throw invalid(`${where}.url must be an http(s) URL.`);
      return { label, url };
    }
    return { label, path: cwd && !path.isAbsolute(filePath ?? '') ? path.resolve(cwd, filePath ?? '') : filePath ?? '' };
  });
}

function invalid(reason: string): PaneError {
  return new PaneError('ERR_NOTIFY_INVALID', `Pane can't show this notify call: ${reason} Nothing was shown.`, 'Fix the field named above and call notify again.');
}
