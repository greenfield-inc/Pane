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
import { ASKING_TAB_CLOSED, cardsOnStatus } from '../services/notify/notifyQueue';
import { readingMachines } from '../daemon/readingMachines';
import { ClaudePromptBridge } from '../services/claudePrompts/claudePromptBridge';
import { setClaudePromptBridge } from '../services/claudePrompts';
import type { MachineConnections } from '../services/machineConnections';
import { LOCAL_MACHINE_ID, type MachineState } from '../../../shared/types/machineConnections';
import { buildWindowAppearanceOptions } from '../services/appearanceService';
import { normalizeAppearance } from '../../../shared/types/appearance';
import { PaneError, paneErrorText } from '../../../shared/paneError';
import { statusCard } from '../services/notify/workerContext';
import { admitCard } from '../services/notify/cardAdmit';
import { checkCard, fitLinks } from '../services/notify/cardCheck';
import { summaryPage } from '../services/notify/summaryPage';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import type { MachineHealthCard } from '../../../shared/types/machineHealth';
import { NOTIFY_LINK_LABEL_MAX, NOTIFY_LINKS_MAX, NOTIFY_QUESTIONS_MAX, type NotifyCommand, type NotifyItem, type NotifyLink, type NotifyQuestion, type NotifyRemoteCommand, type NotifyRequest, type NotifyResult, type NotifySession, type NotifySharedState, type NotifySummaryPage, type NotifyTodoLink } from '../../../shared/types/notify';
import type { RunpaneInboxItem } from '../../../shared/types/runpaneOrchestration';
import type { SessionInboxEnded } from '../services/sessionInbox';
import { thisMachineName, type ApprovalStore } from '../services/approvals/approvalStore';
import type { LoopManager } from '../services/loops/loopManager';
import type { JsonStoreImportOutcome } from '../database/jsonStoreImport';
import type { AgentState } from '../../../shared/types/agentStatus';
import { paneSecretNameProblem, paneSecretProjectProblem, teammateSecretRefusal } from '../../../shared/types/paneSecrets';
import { paneSecretStore, secretLeaseStore } from '../services/paneSecrets';
import { secretLeaseService } from '../services/secretLeaseRuntime';
import type { SecretLeaseStart } from '../services/secretLeaseService';
import { agentLabel } from '../../../shared/agents';
import { openExternalUrl } from '../utils/openExternalUrl';
import { DEFAULT_BROWSER_SETTINGS } from '../../../shared/types/browser';
import { activeTodoService } from '../services/todos/todosFeature';

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
const subQuestionSchema = boundary.object({ title: boundary.string, choices: boundary.array(choiceSchema), why: boundary.optional(boundary.string) });
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
  lease: boundary.optional(boundary.object({ project: boundary.string, names: boundary.array(boundary.string) })),
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

const MAX_LEASE_NAMES = 20;

const answerSchema = boundary.union(
  boundary.object({ picks: boundary.array(boundary.string), text: boundary.optional(boundary.string) }),
  boundary.object({ choice: boundary.nonEmptyString, note: boundary.optional(boundary.string) }),
  boundary.object({
    approved: boundary.boolean,
    note: boundary.optional(boundary.string),
    // Set only by the desktop that started the lease a lease card asks for.
    lease: boundary.optional(boundary.object({
      id: boundary.nonEmptyString,
      expiresAt: boundary.string,
      machines: boundary.array(boundary.string),
      refused: boundary.optional(boundary.array(boundary.string)),
    })),
  }),
  boundary.object({ text: boundary.string }),
);
const idCommand = <const T extends string>(type: T) => boundary.object({ type: boundary.literal(type), id: boundary.nonEmptyString });
const notifyCommandSchema = boundary.union(
  boundary.object({ type: boundary.literal('answer'), id: boundary.nonEmptyString, answer: answerSchema }),
  idCommand('undo'),
  idCommand('dismiss'),
  idCommand('skip'),
  idCommand('open-in-pane'),
  idCommand('ask-agent'),
  boundary.object({ type: boundary.literal('open-link'), id: boundary.nonEmptyString, index: boundary.number, paneId: boundary.optional(boundary.nonEmptyString) }),
  boundary.object({ type: boundary.literal('open-url'), id: boundary.nonEmptyString, url: boundary.nonEmptyString }),
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
const healthCardRowSchema = boundary.object({
  label: boundary.string, detail: boundary.string, bytes: boundary.number,
  note: boundary.optional(boundary.string), skipped: boundary.optional(boundary.boolean), command: boundary.optional(boundary.string),
});
const machineHealthCardSchema = boundary.object({
  kind: boundary.enumeration('disk', 'memory', 'leak', 'finished', 'leftovers'),
  level: boundary.enumeration('ok', 'warning', 'critical'),
  hostname: boundary.string,
  freeBytes: boundary.optional(boundary.number),
  totalBytes: boundary.optional(boundary.number),
  usedBytes: boundary.optional(boundary.number),
  swapUsedBytes: boundary.optional(boundary.nullable(boundary.number)),
  rows: boundary.array(healthCardRowSchema),
  pauseOffer: boundary.optional(boundary.object({ paneCount: boundary.number, memoryMB: boundary.number, hours: boundary.number })),
  leak: boundary.optional(boundary.object({
    pid: boundary.number, started: boundary.string, growthMB: boundary.number, windowMs: boundary.number,
    series: boundary.array(boundary.number), canRestart: boundary.boolean,
  })),
  freesBytes: boundary.optional(boundary.number),
  agentPrompt: boundary.string,
});
/**
 * A machine health card's dialog data, decoded on its own: one this Pane cannot read (a newer
 * kind, a changed field) is dropped, and the item shows as a plain card whose choices still answer it.
 */
const machineHealthField: BoundarySchema<MachineHealthCard | undefined> = { decode: current => decodeOptionalBoundary(current.value, machineHealthCardSchema) };
const todoLinkSchema = boundary.object({
  number: boundary.number,
  title: boundary.string,
  kind: boundary.optional(boundary.enumeration('review', 'stuck', 'question', 'reminder')),
  installId: boundary.optional(boundary.string),
});
/**
 * A card's to-do link, read on its own (T-51): one this Pane can't read (a newer machine's kind, say) leaves the
 * card unlinked, rather than refusing the card and with it every card that machine shares.
 */
const tolerantTodoLinkSchema: BoundarySchema<NotifyTodoLink | undefined> = {
  decode: (cursor) => decodeOptionalBoundary(cursor.value, todoLinkSchema),
};
const notifyItemSchema = boundary.object({
  id: boundary.nonEmptyString,
  ui: boundary.enumeration('options', 'approve', 'ask', 'secret', 'info'),
  title: boundary.string,
  context: boundary.optional(boundary.string),
  choices: boundary.optional(boundary.array(choiceSchema)),
  questions: boundary.optional(boundary.array(subQuestionSchema)),
  replyIsAnswer: boundary.optional(boundary.boolean),
  asSent: boundary.optional(boundary.object({ title: boundary.string, context: boundary.optional(boundary.string) })),
  summaryPage: boundary.optional(boundary.string),
  machineHealth: machineHealthField,
  statusFile: boundary.optional(boundary.string),
  optionsOnly: boundary.optional(boundary.boolean),
  detail: boundary.optional(boundary.string),
  detailLabel: boundary.optional(boundary.string),
  suggestions: boundary.optional(boundary.array(boundary.string)),
  action: boundary.optional(boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString })),
  agentPrompt: boundary.optional(boundary.object({ yes: boundary.string, no: boundary.string, inTerminal: boundary.optional(boundary.boolean) })),
  secret: boundary.optional(boundary.object({ project: boundary.string, name: boundary.string, replaces: boundary.optional(boundary.boolean) })),
  secretError: boundary.optional(boundary.string),
  lease: boundary.optional(boundary.object({
    project: boundary.string,
    names: boundary.array(boundary.string),
    references: boundary.optional(boundary.record(boundary.string)),
    lengthMs: boundary.optional(boundary.number),
    machine: boundary.optional(boundary.string),
    memoryOnly: boundary.optional(boundary.boolean),
    renews: boundary.optional(boundary.string),
  })),
  leaseError: boundary.optional(boundary.string),
  leaseAttempt: boundary.optional(boundary.number),
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
  dismissedAt: boundary.optional(boundary.number),
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
  // The to-do it is linked to, by its number on the asking machine (T-51): the renderer reads it with the card's
  // machineId, so another machine's T-28 names that machine and never matches this one's. Absent from older machines.
  todo: tolerantTodoLinkSchema,
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
type NotifyServices = Pick<AppServices, 'configManager' | 'getMainWindow'> & Partial<Pick<AppServices, 'todoService'>> & {
  sessionManager: Pick<AppServices['sessionManager'], 'getSession'> & Partial<Pick<AppServices['sessionManager'], 'on' | 'off'>>;
  databaseService?: Pick<AppServices['databaseService'], 'getAllProjects'> & Partial<Pick<AppServices['databaseService'], 'getSession' | 'getPanel'>>;
  /** Files each Approvals item under its Session. */
  orchestrationSessionManager?: {
    /** A Session member on another saved machine; its Pane and tabs are not in this computer's database. */
    remoteMember?(paneId: string): { machine: { id: string; label: string } } | undefined;
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
  /** Names the loop a caller runs for, to warn a loop off info cards. */
  loopManager?: Pick<LoopManager, 'loopFor'>;
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

/**
 * Types text into this computer's tab, only at a live agent's prompt: an owed answer, or a to-do's
 * message (D-408). `busy` means try again later.
 */
export async function typeIntoLocalTab(commandRegistry: PaneCommandRegistry, panelId: string, text: string): Promise<TabTypeOutcome> {
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
}

export function registerNotifyHandlers(ipcMain: IpcMain, services: NotifyServices, commandRegistry: PaneCommandRegistry): NotifyService {
  /** Every machine's state, once the machine connections start; "Show cards on" reads it from the first snapshot. */
  let machineList: (() => MachineState[]) | null = null;
  /** Types an owed answer into this computer's tab, only at a live agent's prompt. */
  const typeHere = (panelId: string, text: string): Promise<TabTypeOutcome> => typeIntoLocalTab(commandRegistry, panelId, text);

  // Another computer whose Session holds one of this computer's Panes types its answers through here.
  commandRegistry.register(NOTIFY_TYPE_INTO_TAB, (request: PaneCommandValue) => {
    const { panelId, text } = decodeBoundary(request, boundary.object({ panelId: boundary.nonEmptyString, text: boundary.string }));
    return typeHere(panelId, text);
  });
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
    linksOpenIn: () => services.configManager.getConfig().browser?.openLinksIn ?? DEFAULT_BROWSER_SETTINGS.openLinksIn,
    openExternal: (url) => openExternalUrl(url),
    rendererArguments: () => buildWindowAppearanceOptions(normalizeAppearance(services.configManager.getConfig()).appearance, false, {}).additionalArguments,
    headless: hasHeadlessDaemonLaunchArg(),
    machine: thisMachineName(),
    secrets: {
      exists: (project, name) => paneSecretStore().has(project, name),
      save: async (project, name, value) => { await paneSecretStore().replaceValue(project, name, value); },
    },
    leases: {
      describe: (project, names) => {
        const store = paneSecretStore();
        const references: Record<string, string> = {};
        for (const name of names) {
          const reference = store.referenceOf(project, name);
          if (!reference) continue;
          // The person approves the sites with the lease.
          const sites = store.sitesOf(project, name);
          references[name] = sites ? `${reference} (login for ${sites.join(', ')})` : reference;
        }
        // Only a desktop knows the length it will grant; a headless host's card shows none until a desktop shows it.
        const lengthMs = secretLeaseService()?.lengthFor(project) ?? null;
        return { references, lengthMs, memoryOnly: secretLeaseStore().memoryOnly() };
      },
    },
    startLease: async (item, machineId) => {
      const service = secretLeaseService();
      const lease = item.lease;
      if (!service || !lease) throw new PaneError('SECRET_LEASE_NEEDS_DESKTOP', 'This Pane can\'t start leases. Nothing was leased.', 'Press Start lease in Pane on your Mac or PC.');
      const request: SecretLeaseStart = {
        project: lease.project,
        names: lease.names,
        machines: machineId ? [machineId] : [],
        requestedBy: `${item.source.agent} in "${item.source.name}"`,
      };
      // The length the person approved: this desktop wrote it on the card it showed.
      if (lease.lengthMs) request.lengthMs = lease.lengthMs;
      if (lease.renews) {
        request.renews = lease.renews;
        request.fromReminder = true;
      }
      const started = await service.start(request);
      const refused = started.refused.map(entry => `${entry.machine}: ${entry.reason}`);
      // The machine that asked must hold it, or its agent can't use it.
      if (machineId && refused.length > 0 && !lease.renews) {
        await service.end(started.leaseId);
        throw new PaneError('SECRET_LEASE_REFUSED', `The lease could not reach the machine that asked (${refused.join('; ')}). It was ended everywhere.`, 'Fix that machine, then press Start lease again.');
      }
      return { id: started.leaseId, expiresAt: started.expiresAt, machines: started.machines, refused };
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
    sameLoop: (callerPaneId, askerPaneId) => {
      const loopOf = (paneId: string) => services.loopManager?.loopFor({ paneId, sessionId: services.orchestrationSessionManager?.approvalSession(paneId)?.id })?.id;
      const loop = loopOf(callerPaneId);
      return loop !== undefined && loop === loopOf(askerPaneId);
    },
    projectOf: (paneId) => {
      const projectId = services.databaseService?.getSession?.(paneId)?.project_id;
      return projectId === undefined || projectId === null ? undefined : services.databaseService?.getAllProjects().find(project => project.id === projectId)?.name;
    },
    sessionsById: () => services.orchestrationSessionManager?.approvalSessionsById() ?? new Map(),
    sessionRecord: services.orchestrationSessionManager ? (sessionId) => services.orchestrationSessionManager?.approvalSessionRecord(sessionId) : undefined,
    memberMachine: (paneId) => services.orchestrationSessionManager?.remoteMember?.(paneId)?.machine.label,
    todoOf: (panelId, explicit) => activeTodoService(services)?.todoLinkFor(panelId, explicit),
    onSessionsChanged: (listener) => {
      const sessions = services.orchestrationSessionManager;
      sessions?.on('changed', listener);
      return () => { sessions?.off('changed', listener); };
    },
    inbox: services.sessionInbox,
    store: services.approvalStore,
    importOutcome: services.approvalImport,
    askerPaneGone: (item) => (item.source.paneId && services.orchestrationSessionManager?.remoteMember?.(item.source.paneId)
      ? undefined
      : askerPaneGone(services.databaseService, item)),
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
    typeIntoTab: async (panelId, text, paneId) => {
      // A Session member on another machine: that machine's Pane runs the same checks before it types.
      const member = !panelManager.getPanel(panelId) && paneId ? services.orchestrationSessionManager?.remoteMember?.(paneId) : undefined;
      return member && memberMachines ? typeIntoMemberTab(memberMachines, member.machine.id, panelId, text) : typeHere(panelId, text);
    },
    idleSeconds: () => (hasHeadlessDaemonLaunchArg() ? Infinity : idleSeconds()),
    cardsOn: () => cardsOnStatus(services.configManager.getConfig(), readingMachines.has, machineList?.() ?? []),
    tabAlive: (panelId) => panelManager.getPanel(panelId) !== undefined,
  });

  notifyBeforeQuit = () => notify.queue.prepareForQuit();

  /** Set once the machine connections start: every saved machine's questions then show here. */
  let saved: SavedMachinesLink | null = null;
  followMachines = (machines) => {
    saved = linkSavedMachines(notify, machines);
    machineList = () => machines.list();
  };

  // Open in Pane works for the machine the app is on; another machine's card would need a switch.
  const showActiveMachine = () => {
    const state = remotePaneClientController.getConnectionState();
    notify.queue.setActiveMachine(state.mode === 'remote' && state.activeProfileId ? state.activeProfileId : LOCAL_MACHINE_ID);
  };
  remotePaneClientController.on('state-changed', showActiveMachine);
  showActiveMachine();

  /** An info card disappears, and a loop runs while the person is away, so they rarely see one (#1446). */
  const loopInfoWarning = (request: NotifyRequest): string[] => {
    const { paneId } = request.caller;
    if (request.ui !== 'info' || request.update !== undefined || !paneId) return [];
    const loop = services.loopManager?.loopFor({ paneId, sessionId: services.orchestrationSessionManager?.approvalSession(paneId)?.id });
    return loop
      ? [`The loop "${loop.name}" runs while the person is away, and an info card disappears, so they will likely never see this one. Post findings on a card that waits: --ui options (such as "Got it" / "Not interested") or --ui approve.`]
      : [];
  };

  commandRegistry.register('runpane:notify', async (request: PaneCommandValue): Promise<NotifyResult> => {
    const parsed = parseNotifyRequest(request);
    const todoRef = decodeOptionalBoundary(request, boundary.object({ todo: boundary.optional(boundary.string) }))?.todo?.trim();
    if (todoRef) parsed.todoRef = todoRef;
    const teammate = teammatePaneCaller();
    // A secret card writes the owner's secret store, so a teammate cannot post one.
    if (teammate && parsed.ui === 'secret') throw teammateSecretRefusal(teammate, 'ask for a secret');
    if (teammate && parsed.lease) throw teammateSecretRefusal(teammate, 'ask for a lease');
    const warnings = [...admitNotifyCard(parsed), ...loopInfoWarning(parsed)];
    const result = await notify.ask(parsed, paneCommandSignal());
    // A card that wasn't shown (a worker's, sent back to its orchestrator) has nothing to warn about.
    return warnings.length && !('unavailable' in result) ? { ...result, warnings } : result;
  });

  commandRegistry.register('notify:remote-snapshot', async () => notify.sharedState());
  // An approval's Summary (P4): the asker's page or Pane's template, served with no scripts or network.
  commandRegistry.register('notify:summary-page', async (id: PaneCommandValue, options?: PaneCommandValue): Promise<NotifySummaryPage> => {
    const wanted = decodeBoundary(id, boundary.nonEmptyString);
    const theme = decodeOptionalBoundary(options ?? {}, boundary.object({ theme: boundary.optional(boundary.enumeration('light', 'dark')) }))?.theme ?? 'light';
    const item = notify.queue.snapshot().items.find(candidate => candidate.id === wanted && (candidate.machineId ?? 'local') === 'local');
    if (!item) throw new PaneError('ERR_NOTIFY_GONE', `There's no approval ${wanted} on this machine any more, so it has no Summary to show. Nothing was changed.`, 'Open the approval again from Approvals.');
    return summaryPage(item, theme);
  });
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
      return { paneId: pane.id, panelId, name: pane.name, agent: agentLabel(agent) };
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
export type NotifyMachines = Pick<MachineConnections, 'subscribe' | 'list' | 'read' | 'run'> & Partial<Pick<MachineConnections, 'invokeOn'>>;

/** The saved machines, for typing an answer into a remote Session member's tab. */
let memberMachines: NotifyMachines | null = null;

/** The host channel that types an owed answer into one of its tabs, for a Session on another computer. */
const NOTIFY_TYPE_INTO_TAB = 'notify:type-into-tab';

/** What typing an owed answer into a tab came to. */
type TabTypeOutcome = 'delivered' | 'busy' | 'gone' | 'unsupported' | 'outdated';
const tabTypeOutcomeSchema = boundary.enumeration('delivered', 'busy', 'gone', 'unsupported');

/**
 * Types an answer into a Session member's tab on another saved machine. That machine's Pane runs
 * the same checks as for its own tabs (`notify:type-into-tab`), so an answer is never typed blind.
 */
async function typeIntoMemberTab(machines: NotifyMachines, machineId: string, panelId: string, text: string): Promise<TabTypeOutcome> {
  try {
    const outcome = decodeOptionalBoundary(await machines.invokeOn?.(machineId, NOTIFY_TYPE_INTO_TAB, [{ panelId, text }]), tabTypeOutcomeSchema);
    return outcome ?? 'busy';
  } catch (error) {
    // Its Pane predates remote members, so it never will; otherwise its machine is away and the next sweep tries again.
    if (error instanceof PaneError && error.code === 'ERR_UNKNOWN_CHANNEL') return 'outdated';
    console.warn(`[Notify] Couldn't type into ${machineId}'s tab ${panelId} yet:`, error);
    return 'busy';
  }
}

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
  memberMachines = machines;
  followMachines?.(machines);
}

/**
 * T-51: a card's to-do link is that machine's own to-do. A link naming another machine's install id than the
 * one this machine connected to is shown unlinked rather than as the wrong to-do; a link or machine with no
 * install id (an older Pane) is kept, since on screen a link is read with the card's machine.
 */
function withOwnTodoLinks(state: NotifySharedState, installId: string | undefined): NotifySharedState {
  if (!installId || !state.items.some(item => item.todo?.installId && item.todo.installId !== installId)) return state;
  return { ...state, items: state.items.map(item => (item.todo?.installId && item.todo.installId !== installId ? { ...item, todo: undefined } : item)) };
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
    queue.setRemote(machineId, { machine: machine.label, online: machine.status !== 'offline', state: withOwnTodoLinks(state, machine.installId) });
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

/**
 * The card check every way of asking reaches (P3): a new card, a relayed one and an update are
 * tidied when they are old paragraph cards, refused for the two clear mistakes and warned on the
 * rest. Leaves the request as Pane posts it and returns the warnings. Info and secret cards, and
 * calls that ask nothing (resume, --took), aren't cards to check.
 */
function admitNotifyCard(request: NotifyRequest): string[] {
  if (request.resume || request.took !== undefined) return [];
  if (request.update !== undefined) {
    if (request.title === undefined && !request.choices && !request.questions) return [];
    // An update changes only what it passes; the rest is the approval's, checked when it was asked.
    const { refusal } = checkCard({ title: request.title ?? '', choices: request.choices, questions: request.questions });
    if (refusal) throw new PaneError(refusal.code, refusal.message, refusal.next);
    return [];
  }
  if (!request.ui || request.ui === 'info' || request.ui === 'secret' || request.title === undefined) return [];
  // Only a card asked in words (or with options it hasn't got) is tidied into buttons.
  const tidy = request.ui === 'ask' || request.ui === 'options';
  const admitted = admitCard({ title: request.title, context: request.context, choices: request.choices, questions: request.questions, links: request.links }, { tidy });
  if (admitted.asSent) {
    const { card } = admitted;
    request.ui = 'options';
    request.title = card.title;
    if (card.context !== undefined) request.context = card.context;
    else delete request.context;
    request.choices = card.choices;
    request.questions = card.questions;
    if (!request.choices) delete request.choices;
    if (!request.questions) delete request.questions;
    delete request.suggestions;
    if (card.links) request.links = card.links;
    request.asSent = admitted.asSent;
  }
  return admitted.warnings;
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
    if (!request.tookAs) throw invalid('took needs answer or question: --took <id|Q-n> question.');
    if (request.ui !== undefined || request.update !== undefined) throw invalid('took goes on its own, without ui or update.');
    return request;
  }
  if (request.tookAs !== undefined || request.status !== undefined) throw invalid('answer, question and status only go with took.');
  if (request.update !== undefined) {
    if (!request.update.trim()) throw invalid('update needs the approval\'s id or Q-n.');
    if (request.ui !== undefined) throw invalid('update keeps the approval\'s ui; leave ui out.');
    if (!request.whatChanged?.trim()) throw invalid('update needs whatChanged: one line per change.');
    if ((request.title?.length ?? 0) > MAX_TEXT || (request.asked?.length ?? 0) > MAX_TEXT || request.whatChanged.length > MAX_TEXT) throw invalid(`title, asked and whatChanged take up to ${MAX_TEXT} characters.`);
    if (request.choices && request.questions) throw invalid('pass choices or questions, not both.');
    if (request.choices) checkChoices(request.choices, 'choices');
    if (request.questions) checkQuestions(request.questions);
    if (links !== undefined) request.links = parseLinks(links, request.caller.cwd);
    // The new version's context reads like a new card's; the card keeps its ui, and its links unless given.
    readStatusContext(request, false);
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
  if (request.lease) {
    // Created only by `runpane secrets lease`; the host words the title and fills in the rest.
    if (ui !== 'approve') throw invalid(`lease only goes with ui: approve, not ${ui}.`);
    if (request.lease.names.length === 0 || request.lease.names.length > MAX_LEASE_NAMES) throw invalid(`a lease names 1 to ${MAX_LEASE_NAMES} secrets.`);
    const problem = paneSecretProjectProblem(request.lease.project) ?? request.lease.names.map(paneSecretNameProblem).find(Boolean) ?? null;
    if (problem) throw invalid(problem);
  }
  if (!request.title?.trim()) throw invalid('title is required.');
  if (request.title.length > MAX_TEXT) throw invalid(`title takes up to ${MAX_TEXT} characters.`);
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
  readStatusContext(request, true);
  return request;
}

/** The sender's context as the card shows it: checked after a status file becomes its card, before Pane adds a line. */
function checkContext(request: NotifyRequest): void {
  if ((request.context?.length ?? 0) > MAX_TEXT) throw invalid(`context takes up to ${MAX_TEXT} characters.`);
}

/**
 * A context sent as a status file or a needs_you block (JSON) becomes the card it describes:
 * its question and why as the context, its options as choices on a question that has none, its
 * files as links. Other JSON shows as one plain line, or none; the raw text never shows.
 */
function readStatusContext(request: NotifyRequest, newCard: boolean): void {
  if (!request.context) return;
  const card = statusCard(request.context, request.title ?? '');
  if (!card) {
    checkContext(request);
    return;
  }
  const buttons = newCard && request.ui === 'ask' && !request.suggestions?.length;
  // Questions that can't get buttons here are written out in the context instead.
  const context = card.questions && !buttons ? card.questionsContext : card.context;
  // An update without a line for the person clears the old context rather than keeping it.
  if (context) request.context = context;
  else if (newCard) delete request.context;
  else request.context = '';
  checkContext(request);
  if (!newCard) return;
  if (buttons && card.questions) {
    request.ui = 'options';
    request.questions = card.questions;
  } else if (buttons && card.choices) {
    request.ui = 'options';
    request.choices = card.choices;
  }
  if (card.summaryPage) request.summaryPage = request.caller.cwd && !path.isAbsolute(card.summaryPage) ? path.resolve(request.caller.cwd, card.summaryPage) : card.summaryPage;
  if (card.links) {
    const files = card.links.map(link => ('path' in link && request.caller.cwd && !path.isAbsolute(link.path) ? { ...link, path: path.resolve(request.caller.cwd, link.path) } : link));
    const fitted = fitLinks([...request.links ?? [], ...files], request.context);
    request.links = fitted.links;
    if (fitted.context !== undefined) request.context = fitted.context;
  }
}

/**
 * `runpane report --state blocked --choices|--questions`: the same checks as an options card's,
 * for a report sent by a CLI that did not check them. Neither given is fine.
 */
export function checkNotifyOptions(choices: NotifyRequest['choices'], questions: NotifyRequest['questions']): void {
  if (choices && questions) throw invalid('pass choices or questions, not both.');
  if (choices) checkChoices(choices, 'choices');
  if (questions) checkQuestions(questions);
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
