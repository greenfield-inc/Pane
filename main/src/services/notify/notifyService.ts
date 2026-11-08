import { app, BrowserWindow, globalShortcut } from 'electron';
import { AUTOPILOT_OWNER_PANE_PREFIX } from '../../../../shared/types/autopilot';
import { randomUUID } from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ConfigManager } from '../configManager';
import type { AppConfig } from '../../types/config';
import {
  DEFAULT_NOTIFY_SETTINGS,
  type NotifyCaller,
  type NotifyAgentAction,
  type NotifyCommand,
  type NotifyConnected,
  type NotifyInstructionsFile,
  type NotifyItem,
  type NotifyLink,
  type NotifyNavigateTarget,
  type NotifyRemoteCommand,
  type NotifyRequest,
  type NotifyResult,
  type NotifySession,
  type NotifySettings,
  type NotifySharedState,
  type NotifySnapshot,
  type NotifySource,
  type NotifyWindowSize,
} from '../../../../shared/types/notify';
import { type NotifyQueueEnvironment, NotifyQueue, type NotifyAgentActed } from './notifyQueue';
import { PaneError } from '../../../../shared/paneError';
import { teammateSecretRefusal } from '../../../../shared/types/paneSecrets';
import { canFloatOverOtherApps, NotifyWindows } from './notifyWindows';
import { NotifyTray } from './notifyTray';
import { syncNotifyInstructions, syncWslNotifyInstructions } from './notifyInstructions';
import { isPaneHomeSkillEnabled } from '../paneHomeSkill';
import type { RunpaneInboxItem } from '../../../../shared/types/runpaneOrchestration';
import type { ApprovalStore } from '../approvals/approvalStore';
import type { JsonStoreImportOutcome } from '../../database/jsonStoreImport';
import type { SessionInboxEnded } from '../sessionInbox';

const AGENT_NAMES = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['opencode', 'OpenCode']]);
const agentName = (agentType: string | undefined): string => (agentType ? AGENT_NAMES.get(agentType) : undefined) ?? 'Agent';

export interface NotifyServiceDependencies {
  configManager: ConfigManager;
  getMainWindow: () => BrowserWindow | null;
  /** The Pane and panel a call came from, when its PANE_SESSION_ID / PANE_PANEL_ID check out. */
  findPane: (caller: NotifyCaller) => { paneId: string; panelId?: string; name: string; agentType?: string } | undefined;
  /** Opens a related link as a tab of a Pane (`runpane panels open`); rejects when the Pane can't show it. */
  openLink?: (paneId: string, link: NotifyLink) => Promise<void>;
  /** Arguments the main window's renderer reads before its first paint (theme). */
  rendererArguments: () => string[];
  /** A headless host has no screen: no floating windows, tray or shortcut; connected screens show its questions. */
  headless: boolean;
  /** This machine's name, as connected screens and phones show it. */
  machine: string;
  /** This host's Pane secret store, where secret cards save their answer. */
  secrets?: NotifyQueueEnvironment['secrets'];
  /** Sends the shared state to every connected screen and phone (`notify:shared-changed`). */
  publish: (state: NotifySharedState) => void;
  /** Sends a command for a saved machine's question to that machine, under the id it knows the question by. */
  sendToMachine: (machineId: string, command: NotifyRemoteCommand) => Promise<void>;
  /** Reads a saved machine's state again, after it refused or missed a command. */
  refreshMachine: (machineId: string) => void;
  /** The phone alert: sent about 90 s after a question starts ringing if it's still waiting, cleared when it stops (D-144). */
  onQuestion?: (event: { item: NotifyItem; open: boolean }) => void;
  /** WSL distros Pane runs agents in (its WSL projects'), whose homes get the instructions too. */
  wslDistros?: () => string[];
  /** The Session a Pane (and tab) works in; Approvals files each item under it. */
  sessionOf?: (paneId: string, panelId?: string) => NotifySession | undefined;
  /** The project a Pane belongs to. */
  projectOf?: (paneId: string) => string | undefined;
  /** Every open Session by id, read once per fallback refresh. */
  sessionsById?: () => Map<string, NotifySession>;
  /** A Session's name and state, archived too; undefined once it's gone. */
  sessionRecord?: (sessionId: string) => { name: string; paneId: string; archived: boolean } | undefined;
  /** Hears Session changes, which can end their items. */
  onSessionsChanged?: (listener: () => void) => () => void;
  /** Every Session's unacknowledged worker reports; a blocked one's question is a card. */
  inbox?: { all(): RunpaneInboxItem[]; subscribe(listener: () => void): () => void; subscribeEnded(listener: (ended: SessionInboxEnded) => void): () => void; ack?(ids: readonly string[]): void };
  /** This machine's approvals table. */
  store?: ApprovalStore;
  /** How moving the saved inbox into the table went on this start. */
  importOutcome?: JsonStoreImportOutcome;
  /** Why this item's Pane or tab can no longer take an answer. */
  askerPaneGone?: (item: NotifyItem) => string | undefined;
  /** Hears Panes and tabs closing, which can end their items. */
  onAskersChanged?: (listener: () => void) => () => void;
  /** Types into an asker's tab once an agent is at its prompt; outcomes as NotifyQueueEnvironment's. */
  typeIntoTab?: NotifyQueueEnvironment['typeIntoTab'];
  /** Seconds since the person last used this computer; Infinity while its screen is locked. Absent: in use. */
  idleSeconds?: () => number;
}

/** A computer rings only if used in the last 2 minutes (D-144). */
const IN_USE_SECONDS = 120;
/** How often Pane re-reads that, while something waits. */
const IN_USE_POLL_MS = 5_000;
const SWEEP_MS = 60_000;
/** Bursts of Pane and Session events settle before one sweep. */
const SWEEP_SETTLE_MS = 500;

/** The phone is pushed for what's still waiting after this long (D-144; tests shorten it). */
function pushAfterMs(): number {
  const configured = Number(process.env.PANE_APPROVALS_PUSH_AFTER_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 90_000;
}

/**
 * Pane Notify in the main process: the queue plus every surface that shows it (the floating
 * strip and round, the tray icon, the main window) and the answer-all shortcut.
 */
export class NotifyService {
  readonly queue: NotifyQueue;
  private readonly windows: NotifyWindows;
  private readonly tray: NotifyTray;
  private shortcut: string | null = null;
  private shortcutRegistered = true;
  private broadcastPending = false;
  private lastSettings: NotifySettings;
  private lastAppearance: string;
  private instructionFiles: NotifyInstructionsFile[] = [];
  private homeSkill: boolean;
  /** One WSL sync at a time, in the order the settings changed. */
  private wslSync: Promise<void> = Promise.resolve();
  private lastShared = '';
  private lastStates = new Map<string, boolean>();
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pushed = new Set<string>();
  private mainWindowFocused = false;
  private readonly stoppers: Array<() => void> = [];
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private sweepTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: NotifyServiceDependencies) {
    this.lastSettings = this.settings();
    this.homeSkill = isPaneHomeSkillEnabled(deps.configManager.getConfig());
    this.lastAppearance = appearanceKey(deps.configManager.getConfig());
    this.queue = new NotifyQueue({
      settings: () => this.settings(),
      showOutsideSupported: !deps.headless && canFloatOverOtherApps(),
      shortcutRegistered: () => this.shortcutRegistered,
      instructionFiles: () => this.instructionFiles,
      machine: deps.machine,
      secrets: deps.secrets,
      sessionOf: deps.sessionOf,
      projectOf: deps.projectOf,
      store: deps.store,
      askerGone: (item) => this.askerGone(item),
      inUse: deps.idleSeconds ? () => (deps.idleSeconds?.() ?? 0) < IN_USE_SECONDS : undefined,
      typeIntoTab: deps.typeIntoTab,
      workerQuestionGone: (inboxId) => {
        try {
          deps.inbox?.ack?.([inboxId]);
        } catch (error) {
          console.warn('[Notify] Could not clear a closed question from its inbox; the orchestrator can still ack it:', error);
        }
      },
    });
    this.windows = new NotifyWindows({
      rendererArguments: deps.rendererArguments,
      position: () => this.settings().position,
      onRoundClosed: () => this.queue.setRoundOpen(false),
    });
    this.tray = new NotifyTray({
      openRound: (itemId) => this.openRound(itemId),
      setShowOutsidePane: (show) => {
        this.updateSettings({ showOutsidePane: show }).catch((error: Error) => {
          // The menu flipped its checkbox; redraw it from the setting that is still saved.
          console.error(`[Notify] Show outside Pane was not saved because Pane could not write its config (${error.message}). The setting is unchanged. Free disk space or fix the config folder's permissions, then try again in Settings → Approvals.`);
          this.scheduleBroadcast();
        });
      },
      pause: () => this.queue.run({ type: 'pause', minutes: 60 }),
      resume: () => this.queue.run({ type: 'resume' }),
      openInbox: () => this.navigate('inbox'),
      openSettings: () => this.navigate('settings'),
    });
    this.queue.on('change', () => this.scheduleBroadcast());
    this.queue.on('chime', () => this.sendToMainWindow('notify:chime'));
    deps.configManager.on('config-updated', (config: AppConfig) => {
      const homeSkill = isPaneHomeSkillEnabled(config);
      const homeSkillChanged = homeSkill !== this.homeSkill;
      this.homeSkill = homeSkill;
      const instructionsChanged = this.applySettings(notifySettings(config));
      // The block names the `pane` skill only while it is installed.
      if (homeSkillChanged && !instructionsChanged && this.lastSettings.enabled) this.syncInstructions(true);
      // The floating windows read the palette when they load, so a new palette recreates them.
      const appearance = appearanceKey(config);
      if (appearance === this.lastAppearance) return;
      this.lastAppearance = appearance;
      this.windows.destroy();
      this.scheduleBroadcast();
    });
    this.applyShortcut(this.lastSettings);
    this.syncInstructions(this.lastSettings.enabled);
    if (deps.inbox) {
      this.stoppers.push(deps.inbox.subscribe(() => this.addWorkerQuestions()));
      this.stoppers.push(deps.inbox.subscribeEnded((ended) => this.workerQuestionEnded(ended)));
    }
    this.addWorkerQuestions();
    const outcome = deps.importOutcome;
    if (outcome?.status === 'failed') this.queue.setImportError({ code: outcome.error.code ?? 'ERR_JSON_STORE_IMPORT', message: outcome.error.message, next: outcome.error.next ?? 'Restart Pane to retry.' });
    // Today's backlog, once, on the first start of this build (J25).
    if (outcome?.status === 'imported') this.queue.upgradeCleanup();
    for (const subscribe of [deps.onSessionsChanged, deps.onAskersChanged]) {
      const stop = subscribe?.(() => this.scheduleSweep());
      if (stop) this.stoppers.push(stop);
    }
    this.timers.push(setInterval(() => this.queue.sweep(), SWEEP_MS));
    this.timers.push(setInterval(() => this.queue.pollInUse(), IN_USE_POLL_MS));
    for (const timer of this.timers) timer.unref?.();
    this.queue.sweep();
    this.scheduleBroadcast();
  }

  /** Each worker's blocked question is a card from the start (J7). */
  private addWorkerQuestions(): void {
    const inbox = this.deps.inbox;
    if (!inbox) return;
    const carded = new Set<string>();
    for (const entry of inbox.all()) {
      const question = entry.kind === 'report' && entry.report?.state === 'blocked' ? entry.report.question?.trim() : undefined;
      const at = Date.parse(entry.at);
      if (!question || !Number.isFinite(at)) continue;
      // One card per tab's question, however many Sessions the worker's Pane is in.
      const once = `${entry.panelId}:${entry.at}`;
      if (carded.has(once)) continue;
      carded.add(once);
      const session = this.deps.sessionRecord?.(entry.sessionId);
      const source: NotifySource = { paneId: entry.paneId, panelId: entry.panelId, name: entry.paneName, agent: agentName(entry.agentType) };
      if (session) source.session = { id: entry.sessionId, name: session.name, paneId: session.paneId };
      this.queue.addWorkerQuestion({
        id: entry.id,
        question,
        source,
        at,
        // The Session it was filed in, even after the worker has moved or the Session closed.
        connected: { kind: 'session', id: entry.sessionId, name: session?.name ?? 'Closed Session', paneId: session?.paneId ?? '' },
        // D-81: the worker's status file, which its report named, opens beside the card.
        links: entry.report?.summaryPath ? [{ label: `${entry.paneName} status`, path: entry.report.summaryPath }] : undefined,
      });
    }
  }

  private workerQuestionEnded({ id, how, decision }: SessionInboxEnded): void {
    if (decision) this.queue.recordDecision(id, decision);
    this.queue.endWorkerQuestion(id, how === 'moved-on' ? 'the worker moved on' : 'its orchestrator dealt with it');
  }

  /** The liveness rule (D-147): connected Session first, then the Pane and the tab that asked. */
  private askerGone(item: NotifyItem): string | undefined {
    const connected = item.connected;
    if (connected?.kind === 'session' && this.deps.sessionRecord) {
      const session = this.deps.sessionRecord(connected.id);
      if (!session) return 'Session closed';
      if (session.archived) return 'Session archived';
    }
    return this.deps.askerPaneGone?.(item);
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.queue.sweep();
    }, SWEEP_SETTLE_MS);
    this.sweepTimer.unref?.();
  }

  settings(): NotifySettings {
    return notifySettings(this.deps.configManager.getConfig());
  }

  /** The `runpane:notify` daemon command. */
  ask(request: NotifyRequest, signal?: AbortSignal): Promise<NotifyResult> {
    const { resume, relays, aboutSession, returnAfterMs, caller, ...question } = request;
    const source = this.describeSource(caller);
    // D-79: in a Pane Session only the orchestrator asks the person; a worker asks its orchestrator.
    // Claude's and chat tabs' own prompts (the tool asking) don't come through here, so they still reach you.
    const session = !resume && source.paneId ? this.deps.sessionOf?.(source.paneId, source.panelId) : undefined;
    if (session && !session.orchestrator && !relays && this.settings().enabled) {
      return Promise.resolve({
        unavailable: 'Not shown to the person: in a Pane Session, only the orchestrator asks the person.',
        next: `Ask the ${session.name} orchestrator instead: run runpane report --state blocked --question "<your question>", then wait for its answer or carry on with anything that doesn't depend on it.`,
      });
    }
    return this.queue.ask({
      question: question.ui && question.title !== undefined ? { ...question, ui: question.ui, title: question.title } : undefined,
      resume,
      relays,
      returnAfterMs,
      source,
      connected: source.autopilot ? this.aboutSession(aboutSession) : undefined,
    }, signal);
  }

  /** Autopilot's own item links to the Session it's about, or to its chat (D-168). */
  private aboutSession(about: string | undefined): NotifyConnected | undefined {
    const wanted = about?.trim();
    if (!wanted) return undefined;
    for (const session of this.deps.sessionsById?.().values() ?? []) {
      if (session.id === wanted || session.name === wanted) return { kind: 'session', id: session.id, name: session.name, paneId: session.paneId };
    }
    throw new PaneError('ERR_NOTIFY_INVALID', `Pane can't link this notify call to the Session "${wanted}": no open Session has that id or name. Nothing was shown.`, 'Pass a Session from runpane sessions list, or leave aboutSession out.');
  }

  snapshot(): NotifySnapshot {
    return this.queue.snapshot();
  }

  /**
   * Autopilot acts on an item, wherever it lives (D-165): this machine's it applies here; another
   * machine's goes there, which applies it and records "by Autopilot". Nothing is queued.
   */
  async agentAct(action: NotifyAgentAction): Promise<NotifyAgentActed & { machine?: string }> {
    const target = this.queue.remoteTarget(action.id);
    if (!target) return this.queue.agentAct({ ...action, machine: this.deps.machine });
    if (!target.online) {
      throw new PaneError('ERR_APPROVALS_MACHINE_OFFLINE', `${target.machine} is offline, so Autopilot can't change its items. Nothing was sent.`, `Try again when ${target.machine} is back; its items return by themselves.`);
    }
    const sent: NotifyAgentAction = action.type === 'agent-rewrite' ? { ...action, newId: randomUUID() } : action;
    try {
      await this.deps.sendToMachine(target.machineId, { ...sent, id: target.id, machine: this.deps.machine });
    } catch (error) {
      this.deps.refreshMachine(target.machineId);
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      if (code.startsWith('ERR_NOTIFY') || code.startsWith('AUTOPILOT') || UNREACHABLE_CODES.has(code)) throw error;
      // A machine too old for these commands refuses them when it decodes them.
      throw new PaneError('ERR_APPROVALS_OWNER_TOO_OLD', `${target.machine} refused this (${error instanceof Error ? error.message : String(error)}). It may run an older Pane that can't take Autopilot's answers. Nothing was changed there.`, `Update Pane on ${target.machine}.`);
    }
    return { id: sent.type === 'agent-rewrite' && sent.newId ? `${target.machineId}:${sent.newId}` : action.id, machine: target.machine };
  }

  async run(command: NotifyCommand): Promise<void> {
    switch (command.type) {
      case 'open-round': this.openRound(command.id); return;
      case 'close-round': this.windows.closeRound(); return;
      case 'open-inbox': this.navigate('inbox'); return;
      case 'show-details': await this.updateSettings({ showDetails: command.shown }); return;
      case 'open-in-pane': await this.openInPane(command.id); return;
      case 'open-link': await this.openLink(command.id, command.index, command.paneId); return;
      default:
        if ('id' in command && command.id && this.queue.remoteTarget(command.id)) await this.runOnMachine(command);
        else await this.queue.run(command);
    }
  }

  /** The `notify:remote-command` daemon command: another screen or a phone acts on this machine's question. */
  async runRemote(command: NotifyRemoteCommand, device: string, teammate: string | null): Promise<void> {
    if (command.type === 'open-link') {
      await this.openLink(command.id, command.index, command.paneId);
      return;
    }
    // A phone on Autopilot's machine answers an item another machine holds (D-165): this machine passes it on.
    const target = this.queue.remoteTarget(command.id);
    if (target) {
      // The other machine sees this one as the sender, so a teammate's answer to a secret card stops here.
      if (teammate && target.ui === 'secret') throw teammateSecretRefusal(teammate, 'answer a secret card');
      if (!target.online) throw new PaneError('ERR_APPROVALS_MACHINE_OFFLINE', `${target.machine} is offline, so this item can't change. Nothing was sent.`, `Try again when ${target.machine} is back.`);
      await this.deps.sendToMachine(target.machineId, { ...command, id: target.id });
      return;
    }
    await this.queue.runRemote(command, device, teammate);
  }

  sharedState(): NotifySharedState {
    return this.queue.sharedState();
  }

  /**
   * A command for a saved machine's question: it goes to that machine only, under the id the
   * machine knows the question by. What stays on this screen runs here.
   */
  private async runOnMachine(command: Exclude<Extract<NotifyCommand, { id: string }>, { type: 'open-in-pane' | 'open-link' }>): Promise<void> {
    const target = this.queue.remoteTarget(command.id);
    if (!target) return;
    if (command.type === 'close' || command.type === 'reopen' || command.type === 'override') {
      if (!target.online) {
        throw new PaneError('ERR_APPROVALS_MACHINE_OFFLINE', `${target.machine} is offline, so this item can't change. Nothing was sent.`, `Try again when ${target.machine} is back.`);
      }
      try {
        await this.deps.sendToMachine(target.machineId, { ...command, id: target.id });
      } finally {
        this.deps.refreshMachine(target.machineId);
      }
      return;
    }
    if (command.type === 'hover-info') {
      this.queue.run(command);
      return;
    }
    let machineCommand: NotifyRemoteCommand;
    if (command.type === 'remind') {
      const { after } = command;
      // "When I switch to Pane" waits for this Pane only.
      if (after === 'pane') {
        this.queue.remindHere(command.id);
        return;
      }
      machineCommand = { ...command, id: target.id, after };
    } else {
      machineCommand = { ...command, id: target.id };
    }
    // ✕ on a "Sent to" or "Stopped waiting" card only clears this screen's strip.
    if (command.type === 'dismiss' && !this.queue.snapshot().queue.includes(command.id)) {
      this.queue.run(command);
      return;
    }
    if (!target.online) {
      // The person typed an answer: say it went nowhere, rather than let the card fold away (F-2).
      if (command.type === 'answer') throw new PaneError('ERR_APPROVALS_MACHINE_OFFLINE', `Not sent: ${target.machine} is offline, so your answer didn't reach it.`, `Answer again when ${target.machine} is back.`);
      return;
    }
    // Before the send: the machine's next state can arrive before its reply does.
    if (command.type === 'answer') this.queue.noteAnsweredHere(command.id, true);
    try {
      await this.deps.sendToMachine(target.machineId, machineCommand);
    } catch (error) {
      if (command.type === 'answer') this.queue.noteAnsweredHere(command.id, false);
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      console.warn(`[Notify] ${command.type} was not sent to ${target.machine}:`, error);
      // The cards say so until a read of the machine succeeds: now, if the link is back, or on reconnect.
      if (UNREACHABLE_CODES.has(code)) this.queue.setRemote(target.machineId, { machine: target.machine, online: false });
      // Refused (another screen got there first, or the hold ended): the machine's state says how.
      this.deps.refreshMachine(target.machineId);
      if (command.type === 'answer') {
        throw UNREACHABLE_CODES.has(code)
          ? new PaneError('ERR_APPROVALS_MACHINE_OFFLINE', `Not sent: ${target.machine} went offline, so your answer didn't reach it.`, `Answer again when ${target.machine} is back.`)
          : error;
      }
    }
  }

  setMainWindowFocused(focused: boolean): void {
    this.mainWindowFocused = focused;
    this.queue.setPaneFocused(focused);
  }

  resizeWindow(sender: Electron.WebContents, size: NotifyWindowSize): void {
    this.windows.resize(sender, size);
  }

  focusWindow(sender: Electron.WebContents): void {
    if (this.windows.isNotifyWindow(sender)) this.windows.focusStrip();
  }

  /**
   * Windows and Linux quit when the last window closes. Hidden floating windows still count, so
   * once only they are left they close too, and Pane quits as it did before Notify.
   */
  closeFloatingWindowsIfAlone(): void {
    if (process.platform === 'darwin') return;
    const others = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && !this.windows.isNotifyWindow(window.webContents));
    if (others.length === 0) this.windows.destroy();
  }

  dispose(): void {
    for (const stop of this.stoppers) stop();
    for (const timer of this.timers) clearInterval(timer);
    clearTimeout(this.sweepTimer);
    for (const timer of this.pushTimers.values()) clearTimeout(timer);
    this.queue.dispose();
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    this.tray.destroy();
    this.windows.destroy();
  }

  private openRound(itemId?: string): void {
    if (!this.settings().enabled || !this.queue.hasWaiting()) return;
    this.queue.setRoundOpen(true);
    this.windows.openRound(itemId);
  }

  /** A pane:// link to a tab: Open in Pane for the tab's oldest waiting question, if one waits. */
  async showWaitingCard(paneId: string, panelId: string): Promise<void> {
    const itemId = this.queue.waitingCardFrom(paneId, panelId);
    if (itemId) await this.openInPane(itemId);
  }

  /** Open in Pane: Pane comes to the front on Approvals, with this item selected beside its Session or Pane. */
  private async openInPane(itemId: string): Promise<void> {
    if (!this.queue.snapshot().items.some(candidate => candidate.id === itemId)) return;
    this.windows.closeRound();
    this.navigate({ approval: itemId });
  }

  /**
   * Approvals: a related link opens as a tab of the Pane shown beside the card. A file outside
   * that Pane's worktree opens in the asking Pane instead.
   */
  private async openLink(itemId: string, index: number, shownPaneId: string | undefined): Promise<void> {
    const item = this.queue.snapshot().items.find(candidate => candidate.id === itemId);
    const link = item?.links?.[index];
    if (!item || !link || !this.deps.openLink) {
      throw new PaneError('ERR_APPROVALS_LINK_GONE', 'That link is no longer on the card, so nothing was opened.', 'Open the link from the card again.');
    }
    const openLink = this.deps.openLink;
    // A Session's workspace Pane holds no checkout, so a file outside the shown Pane's worktree
    // opens there as a page (file://), as orchestrators show pages; only then the asking Pane.
    const attempts: Array<[string, NotifyLink]> = [];
    if (shownPaneId) {
      attempts.push([shownPaneId, link]);
      if ('path' in link) attempts.push([shownPaneId, { label: link.label, url: pathToFileURL(link.path).href }]);
    }
    if (item.source.paneId && item.source.paneId !== shownPaneId) attempts.push([item.source.paneId, link]);
    let failure: unknown;
    for (const [paneId, target] of attempts) {
      try {
        await openLink(paneId, target);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw new PaneError('ERR_APPROVALS_LINK_OPEN',
      `Pane couldn't open ${link.label} as a tab (${failure instanceof Error ? failure.message : 'the card names no Pane'}). Nothing was opened.`,
      'url' in link ? 'Open the address in your browser.' : 'Check the file still exists inside the asking Pane\'s folder.');
  }

  private navigate(target: NotifyNavigateTarget): void {
    const window = this.deps.getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.webContents.send('notify:navigate', target);
  }

  private async updateSettings(update: Partial<NotifySettings>): Promise<void> {
    await this.deps.configManager.updateConfig({ notify: update });
  }

  /** Returns whether it synced the instruction files. */
  private applySettings(next: NotifySettings): boolean {
    const previous = this.lastSettings;
    this.lastSettings = next;
    if (previous.enabled && !next.enabled) this.queue.turnOff();
    if (previous.shortcut !== next.shortcut || previous.enabled !== next.enabled) this.applyShortcut(next);
    if (previous.enabled !== next.enabled) this.syncInstructions(next.enabled);
    this.scheduleBroadcast();
    return previous.enabled !== next.enabled;
  }

  /**
   * Keeps Pane's block in the agents' user-level instruction files while Notify is on: this
   * machine's home now, and on Windows each WSL project's distro home once it answers.
   */
  private syncInstructions(enabled: boolean): void {
    // PANE_DIR isolates app data, not the person's agent configuration: isolated runtimes leave it alone.
    if (process.env.PANE_DISABLE_OS_INTEGRATION === '1') return;
    const options = { homeSkill: this.homeSkill };
    const local = syncNotifyInstructions(enabled, options);
    this.instructionFiles = local;
    const distros = process.platform === 'win32' ? [...new Set(this.deps.wslDistros?.() ?? [])] : [];
    if (distros.length === 0) return;
    this.wslSync = this.wslSync
      .then(() => syncWslNotifyInstructions(enabled, options, distros))
      .then(wsl => {
        // A later sync already replaced this one's local results.
        if (this.instructionFiles !== local) return;
        this.instructionFiles = [...local, ...wsl];
        this.scheduleBroadcast();
      })
      .catch((error: Error) => console.warn('[Notify] Pane could not update the instructions in WSL homes:', error));
  }

  private applyShortcut(settings: NotifySettings): void {
    if (this.shortcut) globalShortcut.unregister(this.shortcut);
    this.shortcut = null;
    this.shortcutRegistered = true;
    if (this.deps.headless || !settings.enabled || !settings.shortcut) return;
    try {
      // register() returns false when another app already holds the shortcut.
      // While Pane is in front the shortcut opens Approvals; over other apps it opens the round.
      this.shortcutRegistered = globalShortcut.register(settings.shortcut, () => {
        if (this.mainWindowFocused) this.navigate('inbox');
        else this.openRound();
      });
    } catch (error) {
      console.warn(`[Notify] ${settings.shortcut} is not a shortcut Pane can register:`, error);
      this.shortcutRegistered = false;
    }
    if (this.shortcutRegistered) this.shortcut = settings.shortcut;
  }

  private describeSource(caller: NotifyCaller): NotifySource {
    const pane = this.deps.findPane(caller);
    const agent = caller.agent?.trim() || (pane?.agentType ? AGENT_NAMES.get(pane.agentType) : undefined) || 'Agent';
    if (pane) {
      const source: NotifySource = { paneId: pane.paneId, name: pane.name, agent };
      if (pane.panelId) source.panelId = pane.panelId;
      if (pane.paneId.startsWith(AUTOPILOT_OWNER_PANE_PREFIX)) { source.autopilot = true; source.name = 'Autopilot'; }
      return source;
    }
    return { name: caller.cwd ? path.basename(caller.cwd) : 'Outside Pane', agent };
  }

  /** Coalesces a burst of queue changes into one snapshot per tick. */
  private scheduleBroadcast(): void {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    setImmediate(() => {
      this.broadcastPending = false;
      this.broadcast();
    });
  }

  private broadcast(): void {
    this.publishShared();
    if (this.deps.headless) return;
    const snapshot = this.queue.snapshot();
    if (snapshot.stripSurface === 'window') {
      this.windows.showStrip();
      this.queue.noteStripShown();
    } else {
      this.windows.hideStrip();
      if (snapshot.stripSurface === 'pane') this.queue.noteStripShown();
    }
    if (!this.windows.isRoundOpen()) this.queue.setRoundOpen(false);
    this.tray.update({
      settings: snapshot.settings,
      waiting: this.queue.waitingItems().filter(item => item.staleSince === undefined && !item.quiet),
      paused: snapshot.pausedUntil !== null,
      showOutsideSupported: snapshot.showOutsideSupported,
    });
    this.sendToMainWindow('notify:snapshot', snapshot);
    for (const contents of this.windows.webContents()) contents.send('notify:snapshot', snapshot);
  }

  /** Connected screens and phones get the shared state when it changes, not on this screen's own moves. */
  private publishShared(): void {
    const state = this.queue.sharedState();
    // The revision also rises on changes that never reach the shared state, such as another
    // machine's questions arriving; publishing those would echo between two machines forever.
    const key = JSON.stringify({ ...state, revision: undefined });
    if (key === this.lastShared) return;
    const previous = this.lastStates;
    this.lastShared = key;
    this.lastStates = new Map(state.items.map(item => [item.id, ringing(item)]));
    this.deps.publish(state);
    this.followPush(state, previous);
  }

  /**
   * The machine holding an item pushes the phone (it can't wake itself), about 90 s after the item
   * starts ringing and only if it's still waiting (D-144). Quiet and stale items never push.
   */
  private followPush(state: NotifySharedState, previous: Map<string, boolean>): void {
    if (!this.deps.onQuestion) return;
    const onQuestion = this.deps.onQuestion;
    for (const item of state.items) {
      if (item.state === 'info') continue;
      const open = ringing(item);
      if (open === previous.get(item.id)) continue;
      if (open) {
        if (item.pushed || this.pushTimers.has(item.id)) continue;
        const left = Math.max(0, item.createdAt + pushAfterMs() - Date.now());
        const timer = setTimeout(() => {
          this.pushTimers.delete(item.id);
          this.pushed.add(item.id);
          this.queue.markPushed(item.id);
          onQuestion({ item, open: true });
          // A question that just started ringing (out of its orchestrator's first call) gets the whole wait.
        }, previous.has(item.id) ? pushAfterMs() : left);
        timer.unref?.();
        this.pushTimers.set(item.id, timer);
        continue;
      }
      const timer = this.pushTimers.get(item.id);
      if (timer) {
        clearTimeout(timer);
        this.pushTimers.delete(item.id);
      }
      // Only an alert that went out needs taking back.
      if (this.pushed.delete(item.id) || item.pushed) onQuestion({ item, open: false });
    }
    for (const [id, timer] of this.pushTimers) {
      if (state.items.some(item => item.id === id)) continue;
      clearTimeout(timer);
      this.pushTimers.delete(id);
    }
  }

  private sendToMainWindow(channel: string, ...args: unknown[]): void {
    const window = this.deps.getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
  }
}

/** Failures that mean the machine wasn't reached, as opposed to the machine refusing the command. */
const UNREACHABLE_CODES = new Set(['ERR_REMOTE_OFFLINE', 'ERR_REMOTE_TRANSPORT', 'ERR_MACHINE_OFFLINE', 'ERR_MACHINE_UNKNOWN']);

/** Waiting on the person, and allowed to interrupt them. */
function ringing(item: NotifyItem): boolean {
  return item.state === 'waiting' && !item.quiet && item.staleSince === undefined;
}

function notifySettings(config: AppConfig): NotifySettings {
  return { ...DEFAULT_NOTIFY_SETTINGS, ...config.notify };
}

function appearanceKey(config: AppConfig): string {
  return JSON.stringify([config.appearanceMode, config.theme, config.systemLightTheme, config.systemDarkTheme, config.highContrast]);
}
