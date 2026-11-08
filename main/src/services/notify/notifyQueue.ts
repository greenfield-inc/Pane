import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  NotifyActor,
  NotifyAgentAction,
  NotifyAnswer,
  NotifyClosed,
  NotifyConnected,
  NotifyInstructionsFile,
  NotifyItem,
  NotifyQuestion,
  NotifyRemindAfter,
  NotifyRemoteCommand,
  NotifyResult,
  NotifySession,
  NotifySettings,
  NotifySharedState,
  NotifySnapshot,
  NotifySource,
  NotifyStripView,
} from '../../../../shared/types/notify';
import { PaneError } from '../../../../shared/paneError';
import { teammateSecretRefusal } from '../../../../shared/types/paneSecrets';
import { leadingQn } from '../../../../shared/autopilotDecision';
import { connectedOf, originOf, type ApprovalStore } from '../approvals/approvalStore';

/** Pane holds an answer this long so Undo can take it back. */
const NOTIFY_UNDO_MS = 3_000;
/** The "stopped waiting" card shows this long before it hides. */
const NOTIFY_EXPIRED_SHOW_MS = 3_000;
/** A client on the resume loop must call again within this long, or it stopped waiting. */
const NOTIFY_RESUME_GRACE_MS = 30_000;
/** A client on the resume loop gets `unavailable` after this long without an answer (D-2). */
const NOTIFY_RESUME_CAP_MS = 15 * 60_000;
/** An agent whose panel sits idle this long while its call is open has stopped waiting. */
const NOTIFY_IDLE_BACKSTOP_MS = 10_000;
/** Answered and updates keep at most this many entries on screen; the store keeps the record. */
const HISTORY_LIMIT = 200;
/** The Answered list shows this long; the store keeps the record for 7 days. */
const HISTORY_MS = 24 * 60 * 60_000;
/** An item unanswered this long goes stale: grouped, and never rings or pushes again (tests shorten it). */
function staleAfterMs(): number {
  const configured = Number(process.env.PANE_APPROVALS_STALE_AFTER_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 3 * 24 * 60 * 60_000;
}
/** A worker's question rings once its orchestrator has left it this long (tests shorten it). */
function relayAfterMs(): number {
  const configured = Number(process.env.PANE_APPROVALS_RELAY_AFTER_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 60_000;
}

const REMIND_AFTER_MS = { '3m': 3 * 60_000, '5m': 5 * 60_000, '15m': 15 * 60_000, '10m': 10 * 60_000, '1h': 60 * 60_000 } satisfies Record<Exclude<NotifyRemindAfter, 'pane'>, number>;
const ASK_IN_TERMINAL = 'Ask in the terminal instead.';
/** A secret must never be typed into a terminal or chat. */
const SECRET_UNAVAILABLE_NEXT = 'Ask the person to save it in Pane under Settings > Secrets, then run your command with `runpane secrets exec`. Do not ask them to paste it into the chat.';

/** A secret card's unavailable result points at Settings, never at the terminal. */
function forSecret(result: NotifyResult): NotifyResult {
  return 'unavailable' in result ? { ...result, next: SECRET_UNAVAILABLE_NEXT } : result;
}

const ASKER_STOPPED = 'the asker stopped waiting';

type Timer = ReturnType<typeof setTimeout>;

interface Waiter {
  resolve: (result: NotifyResult) => void;
  detach: () => void;
}

interface Entry {
  item: NotifyItem;
  waiter?: Waiter;
  /** An answer reached while a resume-loop client was between calls; the next resume takes it. */
  pending?: NotifyResult;
  /** The client returned `waiting` at least once. */
  resumeLoop: boolean;
  holdTimer?: Timer;
  graceTimer?: Timer;
  remindTimer?: Timer;
  idleTimer?: Timer;
  ringTimer?: Timer;
  remindOnPaneFocus?: boolean;
  /** A secret card's value is being written to the store; a second answer waits for it. */
  saving?: boolean;
  /** Saved from before this start: its call is gone, so an answer goes to its tab. */
  restored?: boolean;
}

/** What an item's asker is told when it has no open call: typed into its tab, once, when it's at its prompt. */
interface TabMessage {
  itemId: string;
  panelId: string;
  text: string;
  /** Marks the item's answer delivered. A close or correction just needs saying. */
  answer: boolean;
}

/** Which item Autopilot's action left in place: for a rewrite, the new one. */
export interface NotifyAgentActed {
  id: string;
}

/** A worker's blocked question, as the inbox reports it. */
export interface WorkerQuestion {
  /** The inbox item's id, which the card shares. */
  id: string;
  question: string;
  source: NotifySource;
  /** Epoch ms when it asked. */
  at: number;
  connected?: NotifyConnected;
  links?: NotifyQuestion['links'];
  /** The worker's report summary: what it was doing when it asked. */
  context?: string;
}

export interface NotifyQueueEnvironment {
  settings: () => NotifySettings;
  showOutsideSupported: boolean;
  shortcutRegistered: () => boolean;
  instructionFiles: () => NotifyInstructionsFile[];
  /** This machine's name, as connected screens and phones show it. */
  machine?: string;
  /** Where a secret card's answer goes. The value is passed here and nowhere else. */
  secrets?: {
    exists(project: string, name: string): boolean;
    save(project: string, name: string, value: string): Promise<void>;
  };
  /** The Session a Pane (and tab) works in, filed on each new item; Approvals groups by it. */
  sessionOf?: (paneId: string, panelId?: string) => NotifySession | undefined;
  /** The project a Pane belongs to, filed on each new item. */
  projectOf?: (paneId: string) => string | undefined;
  /** This machine's table. Without one the queue only remembers while it runs. */
  store?: Pick<ApprovalStore, 'saveItem' | 'claim' | 'readItem' | 'openItems' | 'recentItems' | 'prune'>;
  /** Why this item's asker is gone (the owning machine decides, D-145), or undefined while someone can take the answer. */
  askerGone?: (item: NotifyItem) => string | undefined;
  /** The person used this computer in the last 2 minutes, with its screen unlocked (D-144). Absent: yes. */
  inUse?: () => boolean;
  /** A worker's question closed because its asker is gone: its inbox item goes with it. */
  workerQuestionGone?: (inboxId: string) => void;
  /**
   * Types into a tab when an agent is at its prompt. `busy`: try again later. `gone`: the tab is no
   * more. `unsupported`: Pane can't see what runs in that terminal (Windows, WSL, the PTY host).
   */
  typeIntoTab?: (panelId: string, text: string) => Promise<'delivered' | 'busy' | 'gone' | 'unsupported'>;
}

/**
 * One saved machine's questions, shown beside this machine's own. Every id here is the card's
 * key, `<machineId>:<id>`, as the glasses key cards: two machines can hold the same id.
 */
interface RemoteQueue {
  machineId: string;
  machine: string;
  /** What it calls itself, which is what receipts name it by until this screen's picker renames them. */
  hostName: string;
  online: boolean;
  epoch: string;
  revision: number;
  /** Each item carries its key as its id, plus its machine's id and name. */
  items: Map<string, NotifyItem>;
  queue: string[];
  hidden: Set<string>;
}

/** What `setRemote` takes for one machine: its name, whether it answers, and its shared state when read. */
export interface NotifyRemoteUpdate {
  machine: string;
  online: boolean;
  state?: NotifySharedState;
}

/** The machine id this computer's own cards carry (MachineConnections' LOCAL_MACHINE_ID). */
const LOCAL_MACHINE = 'local';

/**
 * The one place that holds every question and update, decides what shows where, and resolves
 * each waiting call. Events: `change` after any state change, `chime` when a question arrives
 * that should make a sound.
 */
export class NotifyQueue extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  /** Waiting question ids, oldest first. */
  private queue: string[] = [];
  private readonly hidden = new Set<string>();
  private transient: { view: NotifyStripView; timer?: Timer } | null = null;
  private paneFocused = false;
  private roundOpen = false;
  private pausedUntil: number | null = null;
  private pauseTimer?: Timer;
  /** The first question ever on a strip carries the "Click to answer" hint for as long as it shows. */
  private hintItemId: string | undefined;
  /** One slot per saved machine with Notify, by machine id. */
  private readonly remotes = new Map<string, RemoteQueue>();
  /** The machine the app is on: `local`, or a saved machine's id. Open in Pane works only there. */
  private activeMachineId = LOCAL_MACHINE;
  /** Orders this machine's shared states for other screens (see NotifySharedState). */
  private readonly epoch = randomUUID();
  private revision = 0;
  /** Other machines' questions this screen answered, by key: they read "Sent to", not "Answered on". */
  private readonly answeredHere = new Set<string>();
  /** Other machines' questions reminded "when I switch to Pane", by key: hidden on this screen only. */
  private readonly remindedHere = new Set<string>();
  /** Saved machines whose questions this screen hasn't read since launch: their cards aren't gone, just not here yet. */
  private readonly unreadMachines = new Set<string>();
  private importError: { code: string; message: string; next: string } | undefined;
  private quitting = false;
  private tabMessages: TabMessage[] = [];
  private readonly tabsTyping = new Set<string>();
  private lastInUse: boolean | undefined;

  constructor(private readonly env: NotifyQueueEnvironment) {
    super();
    this.restore();
  }

  /** Back from the table: what's waiting waits again and its asker is found through its tab (J6). */
  private restore(): void {
    const { store } = this.env;
    if (!store) return;
    const now = Date.now();
    store.prune(now);
    for (const item of store.recentItems(now - HISTORY_MS)) this.entries.set(item.id, { item, resumeLoop: false, restored: true });
    for (const item of store.openItems()) {
      const entry: Entry = { item, resumeLoop: false, restored: true };
      this.entries.set(item.id, entry);
      // A prompt's hook and a call from outside Pane can't come back, and nothing could tell them the answer.
      if (item.agentPrompt || (!item.source.panelId && !item.summaryOf)) {
        item.state = 'expired';
        item.resolvedAt = now;
        item.closed = { by: 'pane', reason: ASKER_STOPPED, at: now };
        this.save(entry);
        continue;
      }
      if (item.state === 'sent') {
        // Pane quit during its Undo hold: the answer stands, and goes to the tab.
        item.state = 'answered';
        item.resolvedAt = now;
        this.save(entry);
        continue;
      }
      this.queue.push(item.id);
      if (item.quiet) this.armRing(entry);
    }
    for (const { item } of this.entries.values()) {
      if (item.state === 'answered' && !item.delivered && !item.undelivered && item.source.panelId && !item.agentPrompt) this.enqueueTabMessage(item, answerLine(item), true);
    }
  }

  private save(entry: Entry): void {
    try {
      this.env.store?.saveItem(entry.item);
    } catch (error) {
      console.warn('[Notify] Could not save an approval; it stays in memory until Pane quits:', error);
    }
  }

  /** Handles one notify call. Resolves when the person answers, the call must return, or the caller leaves. */
  ask(request: { question?: NotifyQuestion; resume?: string; relays?: string; returnAfterMs?: number; source: NotifySource; connected?: NotifyConnected; id?: string }, signal?: AbortSignal): Promise<NotifyResult> {
    const secret = request.question?.ui === 'secret' || (request.resume !== undefined && this.entries.get(request.resume)?.item.ui === 'secret');
    const result = this.askOnce(request, signal);
    return secret ? result.then(forSecret) : result;
  }

  private askOnce(request: { question?: NotifyQuestion; resume?: string; relays?: string; returnAfterMs?: number; source: NotifySource; connected?: NotifyConnected; id?: string }, signal?: AbortSignal): Promise<NotifyResult> {
    if (!this.env.settings().enabled) {
      return Promise.resolve(unavailable('Approvals are off in Pane.'));
    }
    if (request.resume) return this.resume(request.resume, request.returnAfterMs, signal);
    const question = request.question;
    if (!question) return Promise.resolve(unavailable('The call named no question.'));
    if (request.relays) return this.relay(request.relays, question, request.returnAfterMs, signal);

    const source = this.withSession(request.source);
    const again = request.id ? undefined : this.sameQuestion(source, question);
    if (again) {
      // The same tab asks the same thing (after a restart, say): it joins the card already there (J19).
      Object.assign(again.item, question);
      again.restored = false;
      this.save(again);
      const result = this.wait(again, request.returnAfterMs, signal);
      this.changed();
      return result;
    }

    if (question.ui === 'secret' && (!question.secret || !this.env.secrets)) {
      return Promise.resolve(unavailable('This Pane cannot save secrets.'));
    }
    const item: NotifyItem = {
      ...question,
      id: request.id ?? randomUUID(),
      source,
      state: question.ui === 'info' ? 'info' : 'waiting',
      createdAt: Date.now(),
    };
    if (question.secret) {
      const { project, name } = question.secret;
      item.secret = { project, name, replaces: this.env.secrets?.exists(project, name) ?? false };
    }
    item.originKind = originOf(item);
    item.connected = request.connected ?? connectedOf(item, this.machine());
    const entry: Entry = { item, resumeLoop: false };
    this.entries.set(item.id, entry);
    this.save(entry);

    if (question.ui === 'info') {
      // An update never covers a question, a confirmation or an expiry; those send it to the inbox.
      const current = this.strip();
      const delivered = this.canShowStrip() && (current === null || current.kind === 'info') ? 'screen' : 'inbox';
      if (delivered === 'screen') this.showInfo(item.id);
      this.trimHistory();
      this.changed();
      return Promise.resolve({ delivered });
    }

    this.queue.push(item.id);
    // A question never waits behind an update; the update stays under For your information.
    if (this.transient?.view.kind === 'info') this.clearTransient();
    this.chime();
    const result = this.wait(entry, request.returnAfterMs, signal);
    this.changed();
    return result;
  }

  run(command: { type: 'answer'; id: string; answer: NotifyAnswer }
    | { type: 'undo' | 'dismiss' | 'skip' | 'reopen'; id: string }
    | { type: 'close'; id: string; reason?: string }
    | { type: 'override'; id: string; answer: NotifyAnswer }
    | { type: 'remind'; id: string; after: NotifyRemindAfter }
    | { type: 'hover-info'; id: string; hovering: boolean }
    | { type: 'pause'; minutes: number }
    | { type: 'resume' }): void | Promise<void> {
    switch (command.type) {
      case 'answer': return this.answer(command.id, command.answer);
      case 'undo': this.undo(command.id); break;
      case 'close': this.closeBy(command.id, 'you', command.reason ?? ''); break;
      case 'reopen': this.reopenClosed(command.id); break;
      case 'override': this.override(command.id, command.answer, 'you'); break;
      case 'dismiss': this.hide(command.id); break;
      case 'remind': this.remind(command.id, command.after); break;
      case 'skip': this.skip(command.id); break;
      case 'hover-info': this.hoverInfo(command.id, command.hovering); break;
      case 'pause': this.pause(command.minutes); break;
      case 'resume': this.unpause(); break;
    }
  }

  /**
   * The oldest question still waiting from this tab, for a pane:// link to open as Open in Pane
   * does; a question on a machine the app isn't on is left out.
   */
  waitingCardFrom(paneId: string, panelId: string): string | undefined {
    return this.snapshot().items.find(candidate => candidate.state === 'waiting' && !candidate.elsewhere
      && candidate.source.paneId === paneId && candidate.source.panelId === panelId)?.id;
  }

  /**
   * A command from another screen or a phone (`notify:remote-command`). `device` is the server's
   * name for the sender, and `teammate` the login of a sender who is not this computer's owner.
   * Refuses a command for a question no longer in the state it needs.
   */
  runRemote(command: Exclude<NotifyRemoteCommand, { type: 'open-link' }>, device: string, teammate: string | null): void | Promise<void> {
    const entry = this.entries.get(command.id);
    if (!entry) {
      throw new PaneError('ERR_NOTIFY_GONE', `That question is no longer on ${this.machine()}: it finished earlier. Nothing was sent.`, 'Nothing to do: the agent is no longer waiting on it.');
    }
    // Only the person's own machines pass on Autopilot's calls; a teammate would be recorded as Autopilot (F-8).
    if (teammate && command.type.startsWith('agent-')) {
      throw new PaneError('ERR_NOTIFY_NOT_AUTOPILOT', `${teammate} can't act as Autopilot on ${this.machine()}. Nothing was changed.`, 'Answer or close it as yourself instead.');
    }
    if (teammate && entry.item.ui === 'secret' && command.type !== 'dismiss' && command.type !== 'skip' && command.type !== 'remind') {
      throw teammateSecretRefusal(teammate, command.type === 'answer' ? 'answer a secret card' : `${command.type} a secret card`);
    }
    switch (command.type) {
      case 'close': this.closeBy(command.id, 'you', command.reason ?? '', device); return;
      case 'reopen': this.reopenClosed(command.id, device); return;
      case 'override': this.override(command.id, command.answer, 'you'); return;
      case 'agent-answer':
      case 'agent-close':
      case 'agent-rewrite': this.agentAct(command); return;
      default:
    }
    const needs = command.type === 'answer' ? 'waiting' : command.type === 'undo' ? 'sent' : 'queued';
    const state = entry.item.state;
    if ((needs === 'queued' && !this.queue.includes(command.id)) || (needs !== 'queued' && state !== needs)) {
      if (state === 'expired' || state === 'answered' || state === 'sent') throw this.alreadyEnded(entry.item);
      throw new PaneError('ERR_NOTIFY_NOT_SENT', `That question is waiting again (it was undone). Nothing was changed.`, 'Answer it again if you meant to.');
    }
    if (command.type === 'answer') {
      const invalidAnswer = (error: Error): never => {
        if (error instanceof PaneError) throw error;
        throw new PaneError('ERR_NOTIFY_INVALID', `${error.message} Nothing was sent.`, 'Answer with one of the question\'s choices, or the kind of answer it asks for.');
      };
      try {
        const saving = this.answer(command.id, command.answer, device);
        return saving?.catch(invalidAnswer);
      } catch (error) {
        invalidAnswer(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    this.run(command);
  }

  /**
   * A worker's blocked question (J7): a card at once, with an answer box. It rings once its
   * orchestrator relays it or after the grace (D-79's intent: orchestrators answer first what the
   * plan settles). Its asker is its tab, since a worker has no call open.
   */
  addWorkerQuestion(question: WorkerQuestion): void {
    // Already carded: this start, or days ago with the card since answered and off the list.
    if (this.entries.has(question.id) || this.isRewrittenFrom(question.id) || this.env.store?.readItem(question.id)) return;
    const item: NotifyItem = {
      id: question.id,
      ui: 'ask',
      title: question.question,
      source: this.withSession(question.source),
      state: 'waiting',
      createdAt: question.at,
      originKind: 'worker',
    };
    // Past its grace already (brought in from before this start): it shows as ringing, without a chime for each.
    if (Date.now() - question.at < relayAfterMs()) item.quiet = true;
    if (question.links?.length) item.links = question.links;
    if (question.context) item.context = question.context;
    item.connected = question.connected ?? connectedOf(item, this.machine());
    const entry: Entry = { item, resumeLoop: false };
    this.entries.set(item.id, entry);
    this.save(entry);
    this.queue.push(item.id);
    if (item.quiet) this.armRing(entry);
    this.changed();
  }

  /** The inbox let go of a worker's question: the worker moved on, or its orchestrator dealt with it. */
  endWorkerQuestion(id: string, reason: string): void {
    for (const entry of [...this.entries.values()]) {
      if (isOpen(entry.item) && (entry.item.id === id || entry.item.rewrittenFrom?.id === id)) this.closeOpen(entry, { by: 'pane', reason }, closedResult(`Closed: ${reason}.`));
    }
  }

  /** The orchestrator recorded this answer as a D-n (J8). */
  recordDecision(id: string, decision: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.item.decision = decision;
    this.save(entry);
    this.changed();
    return true;
  }

  /**
   * Autopilot acts on this machine's item (D-149, D-150, D-152), recorded on it and delivered at
   * once. Permission prompts stay the person's: they grant an agent power.
   */
  agentAct(action: NotifyAgentAction): NotifyAgentActed {
    const entry = this.entries.get(action.id);
    if (!entry) throw new PaneError('ERR_NOTIFY_GONE', `That item is no longer on ${this.machine()}. Nothing was changed.`, 'List what waits again with runpane autopilot waiting --json.');
    if (entry.item.agentPrompt) {
      throw new PaneError('AUTOPILOT_CANNOT_ANSWER', `Autopilot can't answer or close the permission prompt "${entry.item.title}": permission prompts grant an agent power, so they stay the person's (D-149). Nothing was changed; it still waits.`, 'Point the person to the buttons on its card.');
    }
    if (entry.item.ui === 'secret' && action.type !== 'agent-close') {
      // A secret's value goes only to the secret store, from the person (#1014); Autopilot has none to give.
      throw new PaneError('AUTOPILOT_CANNOT_ANSWER', `Autopilot can't answer or rewrite the secret card "${entry.item.title}": only the person types a secret, into its masked field. Nothing was changed; it still waits.`, 'Point the person to the card.');
    }
    if (action.type === 'agent-close' && entry.item.closed?.reason === ASKER_STOPPED && entry.item.closed.by === 'pane') {
      // The asker left moments before: nobody is left to tell, and the record names Autopilot's decision on every device (D-181).
      entry.item.closed = { by: 'autopilot', reason: action.reason, at: Date.now() };
      entry.item.answeredOn = action.machine;
      this.save(entry);
      this.changed();
      return { id: action.id };
    }
    if (entry.item.state !== 'waiting') throw this.alreadyEnded(entry.item);
    if (action.type === 'agent-answer') {
      this.answerAtOnce(entry, action.answer, { by: 'autopilot', because: action.because }, action.machine);
      return { id: action.id };
    }
    if (action.type === 'agent-close') {
      this.closeBy(action.id, 'autopilot', action.reason, action.machine);
      return { id: action.id };
    }
    return { id: this.rewrite(entry, action.question, action.machine, action.newId) };
  }

  /** A close or answer lost the race, or came too late: says who got there first. */
  private alreadyEnded(item: NotifyItem): PaneError {
    const on = this.deviceLabel(item.answeredOn) ?? this.machine();
    const who = (by: NotifyActor | undefined) => (by === 'autopilot' ? 'Autopilot' : by === 'orchestrator' ? 'the orchestrator' : by === 'pane' ? 'Pane' : 'you');
    if (item.closed && item.closed.reason !== ASKER_STOPPED) {
      return new PaneError('ERR_NOTIFY_EXPIRED', `Already closed by ${who(item.closed.by)} on ${on}${item.closed.reason ? ` (${item.closed.reason})` : ''}. Nothing was sent.`, 'Nothing to do: it is no longer waiting.');
    }
    if (item.state === 'expired') {
      return new PaneError('ERR_NOTIFY_EXPIRED', `${item.source.agent} stopped waiting on this question. Nothing was sent.`, 'Nothing to do: the agent moved on.');
    }
    return new PaneError('ERR_NOTIFY_ANSWERED', `Already answered by ${who(item.answeredBy?.by)} on ${on}. Nothing was sent.`, 'Nothing to do: the agent has its answer.');
  }

  /**
   * The liveness rule on the owning machine (D-147): closes what its asker left, marks what's old,
   * and drops what's past the record. Events call it as well as the 60 s timer.
   */
  sweep(): void {
    const now = Date.now();
    let dirty = false;
    const staleAfter = staleAfterMs();
    for (const entry of [...this.entries.values()]) {
      const { item } = entry;
      if (item.state !== 'waiting') continue;
      const reason = this.env.askerGone?.(item);
      if (reason) {
        this.closeOpen(entry, { by: 'pane', reason }, closedResult(`Closed: ${reason}.`));
        continue;
      }
      // A reopened item counts from the person's Reopen, or it would go straight back to Stale (F-4).
      if (item.staleSince === undefined && now - (item.reopened?.at ?? item.createdAt) >= staleAfter && !item.summaryOf) {
        item.staleSince = now;
        clearTimeout(entry.ringTimer);
        this.save(entry);
        dirty = true;
      }
    }
    if (this.pruneOld()) dirty = true;
    try {
      this.env.store?.prune(now);
    } catch (error) {
      console.warn('[Notify] Could not prune old approvals; the next sweep tries again:', error);
    }
    this.flushTabMessages();
    this.pollInUse();
    if (dirty) this.changed();
  }

  /**
   * The one-time cleanup on the first start of this build (J25): closes every moved item whose
   * asker is gone, then one card lists the rest, oldest first, with Close all and Keep.
   */
  upgradeCleanup(): void {
    const now = Date.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.item.state !== 'waiting') continue;
      const reason = this.env.askerGone?.(entry.item);
      if (reason) this.closeOpen(entry, { by: 'pane', reason: `closed on upgrade: ${reason}`, at: now }, closedResult(`Closed: ${reason}.`));
    }
    const rest = [...this.entries.values()].filter(entry => entry.item.state === 'waiting').map(entry => entry.item).sort((a, b) => a.createdAt - b.createdAt);
    if (rest.length === 0) return;
    const entry: Entry = {
      resumeLoop: false,
      item: {
        id: randomUUID(),
        ui: 'options',
        title: rest.length === 1 ? '1 older approval is still waiting' : `${rest.length} older approvals are still waiting`,
        context: rest.map(item => `• ${item.title}`).join('\n').slice(0, 3_900),
        choices: [{ label: 'Close all' }, { label: 'Keep', recommended: true }],
        source: { name: 'Pane', agent: 'Pane' },
        state: 'waiting',
        createdAt: now,
        originKind: 'pane',
        connected: { kind: 'machine', id: this.machine(), name: 'Pane' },
        summaryOf: rest.map(item => item.id),
      },
    };
    this.entries.set(entry.item.id, entry);
    this.save(entry);
    this.queue.push(entry.item.id);
    this.changed();
  }

  /** Items waiting and old enough to be flagged; connected screens read staleness from each item. */
  private armRing(entry: Entry): void {
    clearTimeout(entry.ringTimer);
    const due = entry.item.createdAt + relayAfterMs() - Date.now();
    entry.ringTimer = setTimeout(() => this.ring(entry), Math.max(0, due));
  }

  /** A worker's question comes out of its orchestrator's first call and starts ringing. */
  private ring(entry: Entry): void {
    clearTimeout(entry.ringTimer);
    if (!entry.item.quiet || entry.item.state !== 'waiting') return;
    entry.item.quiet = undefined;
    this.save(entry);
    if (entry.item.staleSince === undefined) this.chime();
    this.changed();
  }

  /** `runpane notify --relays <item>`: the orchestrator improves the worker's card and waits on it as on any notify (J8). */
  private relay(id: string, question: NotifyQuestion, returnAfterMs: number | undefined, signal?: AbortSignal): Promise<NotifyResult> {
    const entry = this.entries.get(id) ?? [...this.entries.values()].find(candidate => candidate.item.rewrittenFrom?.id === id && isOpen(candidate.item));
    if (!entry || entry.item.originKind !== 'worker' || entry.item.state !== 'waiting') {
      return Promise.resolve({ unavailable: `There's no waiting worker question ${id}: it was answered or closed, or its worker moved on. Nothing was shown.`, next: 'Check runpane inbox for the answer.' });
    }
    const { title, ...improved } = question;
    Object.assign(entry.item, improved, title.trim() ? { title } : {});
    this.ring(entry);
    this.save(entry);
    const result = this.wait(entry, returnAfterMs, signal);
    this.changed();
    return result;
  }

  private isRewrittenFrom(id: string): boolean {
    return [...this.entries.values()].some(entry => entry.item.rewrittenFrom?.id === id);
  }

  /** The waiting card this tab already asked this on: the same Q-n, or the same title. */
  private sameQuestion(source: NotifySource, question: NotifyQuestion): Entry | undefined {
    if (!source.panelId || question.ui === 'info') return undefined;
    const qn = leadingQn(question.title);
    for (const entry of this.entries.values()) {
      const { item } = entry;
      if (item.state !== 'waiting' || item.agentPrompt || item.source.panelId !== source.panelId) continue;
      if (qn ? leadingQn(item.title) === qn : item.title === question.title) return entry;
    }
    return undefined;
  }

  /** An answer that doesn't wait: Autopilot's are delivered at once, with Override for a correction (D-150). */
  private answerAtOnce(entry: Entry, answer: NotifyAnswer, receipt: NonNullable<NotifyItem['answeredBy']>, machine?: string): void {
    const result = toResult(entry.item, answer);
    const before = { ...entry.item };
    entry.item.state = 'answered';
    entry.item.resolvedAt = Date.now();
    entry.item.answerSummary = summarize(entry.item, result);
    entry.item.answeredBy = receipt;
    entry.item.answeredOn = machine;
    entry.item.quiet = undefined;
    if (!this.claimRow(entry, before)) throw this.alreadyEnded(entry.item);
    this.queue = this.queue.filter(other => other !== entry.item.id);
    this.hidden.delete(entry.item.id);
    clearEntryTimers(entry);
    this.handOverAnswer(entry, result);
    this.trimHistory();
    this.changed();
  }

  /** One conditional row write: false means another answer or close got there first, and the row's version is back in memory. */
  private claimRow(entry: Entry, before: NotifyItem): boolean {
    const { store } = this.env;
    if (!store) return true;
    let claimed: boolean;
    try {
      claimed = store.claim(entry.item);
    } catch (error) {
      console.warn('[Notify] Could not save an approval; it stays in memory until Pane quits:', error);
      return true;
    }
    if (claimed) return true;
    const row = store.readItem(entry.item.id);
    if (!row) {
      // An earlier save failed, so there's nothing to race: this write is the row.
      this.save(entry);
      return true;
    }
    entry.item = row;
    return false;
  }

  /** Autopilot's rewrite (D-151): the old item closes, linked to a new one on this machine with the same asker (D-165). */
  private rewrite(entry: Entry, question: NotifyQuestion, machine?: string, newId?: string): string {
    const old = entry.item;
    const fresh: Entry = {
      resumeLoop: entry.resumeLoop,
      restored: entry.restored,
      item: {
        ...question,
        id: newId ?? randomUUID(),
        source: old.source,
        state: 'waiting',
        createdAt: Date.now(),
        originKind: old.originKind,
        connected: old.connected,
        rewrittenFrom: { id: old.id, title: old.title },
      },
    };
    const qn = leadingQn(old.title);
    if (qn && fresh.item.rewrittenFrom) fresh.item.rewrittenFrom.qn = qn;
    // Its call now waits on the rewrite, so the answer still reaches it.
    fresh.waiter = entry.waiter;
    entry.waiter = undefined;
    fresh.pending = entry.pending;
    const before = { ...old };
    old.rewrittenAs = { id: fresh.item.id, title: fresh.item.title };
    old.state = 'expired';
    old.resolvedAt = Date.now();
    old.closed = { by: 'autopilot', reason: `rewritten as ${fresh.item.title}`, at: old.resolvedAt };
    old.answeredOn = machine;
    old.quiet = undefined;
    if (!this.claimRow(entry, before)) throw this.alreadyEnded(entry.item);
    clearEntryTimers(entry);
    this.queue = this.queue.map(other => (other === old.id ? fresh.item.id : other));
    this.hidden.delete(old.id);
    this.entries.set(fresh.item.id, fresh);
    this.save(fresh);
    this.changed();
    return fresh.item.id;
  }

  /** Close: the item ends with a reason, and an asker who can still hear is told (J24). */
  private closeBy(id: string, by: NotifyActor, reason: string, device?: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.item.state !== 'waiting' && entry.item.state !== 'sent') {
      if (by === 'you' && entry.item.state === 'info') return;
      throw this.alreadyEnded(entry.item);
    }
    if (entry.item.agentPrompt) {
      throw new PaneError('ERR_NOTIFY_IN_TERMINAL', `"${entry.item.title}" is a permission prompt, so closing it wouldn't end it: ${entry.item.source.agent} still waits for its answer. Nothing was changed.`, 'Answer it, on its card or in its terminal.');
    }
    entry.item.answeredOn = device;
    const who = by === 'autopilot' ? 'Autopilot' : 'The person';
    const heardOnCall = entry.waiter !== undefined || entry.resumeLoop;
    this.closeOpen(entry, { by, reason }, closedResult(`${who} closed this question${reason ? `: ${reason}` : ''}.`));
    if (!heardOnCall && entry.item.source.panelId) {
      this.enqueueTabMessage(entry.item, `closed: ${askerRef(entry.item)} (by ${by === 'autopilot' ? 'Autopilot' : 'you'})${reason ? `: ${reason}` : ''}`, false);
    }
  }

  private closeOpen(entry: Entry, closed: { by: NotifyActor; reason: string; at?: number }, result: NotifyResult): void {
    this.close(entry.item.id, { state: 'expired', closed: { by: closed.by, reason: closed.reason, at: closed.at ?? Date.now() } }, result, false);
    // Its asker is gone, so its orchestrator has nothing left to act on either.
    if (closed.by === 'pane' && entry.item.originKind === 'worker') this.env.workerQuestionGone?.(entry.item.rewrittenFrom?.id ?? entry.item.id);
  }

  /** Reopen: it waits again, for a tab that can still take the answer. */
  private reopenClosed(id: string, device?: string): void {
    const entry = this.entries.get(id);
    if (!entry || !entry.item.closed) return;
    if (entry.item.rewrittenAs) {
      throw new PaneError('ERR_NOTIFY_REWRITTEN', `This question was rewritten as "${entry.item.rewrittenAs.title}", so reopening it would ask twice. Nothing was changed.`, 'Answer the rewrite, or close it.');
    }
    // Asked from outside Pane: its call ended when the item closed, so an answer would reach no one (F-5).
    if (entry.item.source.panelId === undefined) {
      throw new PaneError('ERR_NOTIFY_ASKER_GONE', 'Nobody can take an answer to this question any more: it was asked from outside Pane, and that call ended when it closed. Nothing was changed.', 'Ask again from where it came from if it still matters.');
    }
    const previous = entry.item.closed;
    entry.item.closed = undefined;
    const gone = this.env.askerGone?.(entry.item);
    if (gone) {
      entry.item.closed = previous;
      throw new PaneError('ERR_NOTIFY_ASKER_GONE', `Nobody can take an answer to this question any more: ${gone}. Nothing was changed.`, 'Ask again from a live Session if it still matters.');
    }
    entry.item.state = 'waiting';
    entry.item.resolvedAt = undefined;
    entry.item.answeredOn = undefined;
    entry.item.staleSince = undefined;
    entry.item.reopened = { by: 'you', at: Date.now(), closedBy: previous.by, closedReason: previous.reason };
    if (device) entry.item.reopened.device = device;
    entry.restored = true;
    this.queue = [id, ...this.queue];
    this.save(entry);
    this.changed();
  }

  /** Override: the person's answer goes to the asker as a correction, recorded on the item (D-150). */
  private override(id: string, answer: NotifyAnswer, by: NotifyActor): void {
    const entry = this.entries.get(id);
    if (!entry || entry.item.state !== 'answered') {
      throw new PaneError('ERR_NOTIFY_NOT_ANSWERED', "That question has no answer to correct. Nothing was sent.", 'Answer it instead.');
    }
    const summary = summarize(entry.item, toResult(entry.item, answer));
    entry.item.corrections = [...entry.item.corrections ?? [], { summary, by, at: Date.now() }];
    this.save(entry);
    if (entry.item.source.panelId) this.enqueueTabMessage(entry.item, `correction: ${askerRef(entry.item)} → ${summary} (by you)`, false);
    this.changed();
  }

  /** The answer goes to an open call; a worker's goes to its tab, since the call open on it is its orchestrator's relay. */
  private handOverAnswer(entry: Entry, result: NotifyResult): void {
    const { item } = entry;
    if (item.summaryOf) {
      this.applySummary(item, result);
    }
    const overCall = entry.waiter !== undefined || entry.resumeLoop;
    if (entry.waiter) entry.waiter.resolve(result);
    else entry.pending = result;
    if (item.source.panelId && !item.agentPrompt && (item.originKind === 'worker' || !overCall)) this.enqueueTabMessage(item, answerLine(item), true);
    else if (overCall) item.delivered = { via: 'call', at: Date.now() };
    this.save(entry);
  }

  /** Close all on the upgrade's summary card. */
  private applySummary(item: NotifyItem, result: NotifyResult): void {
    if (!('answer' in result) || result.answer !== 'Close all') return;
    for (const id of item.summaryOf ?? []) {
      const listed = this.entries.get(id);
      if (listed?.item.state === 'waiting') this.closeBy(id, 'you', 'closed from the upgrade summary');
    }
  }

  private enqueueTabMessage(item: NotifyItem, text: string, answer: boolean): void {
    if (!item.source.panelId || !this.env.typeIntoTab) return;
    // One line: a newline in an answer would submit early, and a control character is a key press.
    this.tabMessages.push({ itemId: item.id, panelId: item.source.panelId, text: text.replace(/\p{Cc}+/gu, ' '), answer });
    this.flushTabMessages();
  }

  /** Types what's owed into each tab at its prompt, one at a time, once. Called when a tab goes idle and by the sweep. */
  flushTabMessages(): void {
    const type = this.env.typeIntoTab;
    if (!type) return;
    for (const message of [...this.tabMessages]) {
      if (this.tabsTyping.has(message.panelId)) continue;
      this.tabsTyping.add(message.panelId);
      let again = false;
      void type(message.panelId, message.text).then((outcome) => {
        if (outcome === 'busy') return;
        again = true;
        this.tabMessages = this.tabMessages.filter(other => other !== message);
        const entry = this.entries.get(message.itemId);
        if (message.answer && entry) {
          // An answer that can never be typed says why, so the person or the orchestrator passes it on (F-3).
          if (outcome === 'delivered') entry.item.delivered = { via: 'tab', at: Date.now() };
          else entry.item.undelivered = { reason: outcome === 'gone' ? 'its tab closed' : "Pane can't see what runs in its tab", at: Date.now() };
          this.save(entry);
          this.changed();
        }
      }).catch((error: Error) => {
        console.warn(`[Notify] Couldn't type into tab ${message.panelId}; the next sweep tries again:`, error);
      }).finally(() => {
        this.tabsTyping.delete(message.panelId);
        // Only after a message went: a busy tab waits for its next idle or the next sweep.
        if (again && this.tabMessages.some(other => other.panelId === message.panelId)) this.flushTabMessages();
      });
    }
  }

  /** The person just came back to, or left, this computer: the strip follows (D-144). */
  pollInUse(): void {
    const now = this.inUse();
    if (now === this.lastInUse) return;
    this.lastInUse = now;
    this.changed();
  }

  /** The phone push for this item went out, so a restart doesn't send it again. */
  markPushed(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.item.pushed) return;
    entry.item.pushed = true;
    this.save(entry);
  }

  private inUse(): boolean {
    return this.env.inUse?.() ?? true;
  }

  private chime(): void {
    const settings = this.env.settings();
    if (settings.enabled && settings.sound && !this.isPaused() && this.inUse()) this.emit('chime');
  }

  /** What no surface should raise, whatever it's asked: quiet and stale items, and what's hidden. */
  private localHidden(): Set<string> {
    const hidden = new Set(this.hidden);
    for (const id of this.queue) {
      const item = this.entries.get(id)?.item;
      if (item?.quiet || item?.staleSince !== undefined) hidden.add(id);
    }
    return hidden;
  }

  /** While Approvals is off, what's saved stays saved, but nothing shows (J1). */
  private localQueue(): string[] {
    return this.env.settings().enabled ? this.queue : [];
  }

  private localItems(): NotifyItem[] {
    const enabled = this.env.settings().enabled;
    return [...this.entries.values()].map(entry => entry.item).filter(item => enabled || !isOpen(item));
  }

  /** What every connected screen and phone shares: the questions, their order and who answered. */
  sharedState(): NotifySharedState {
    this.pruneOld();
    const machine = this.machine();
    return {
      machine,
      epoch: this.epoch,
      revision: this.revision,
      enabled: this.env.settings().enabled,
      // A secret card is shared only while it waits: Pane versions before secrets can't read one,
      // so a finished card left in today's history would keep them from showing this machine's cards.
      items: this.localItems().filter(item => item.ui !== 'secret' || item.state === 'waiting').map(item => (
        item.state === 'sent' || item.state === 'answered' ? { ...item, answeredOn: item.answeredOn ?? machine } : { ...item }
      )),
      queue: [...this.localQueue()],
      // "When I switch to Pane" waits for this Pane only; other screens keep showing the question.
      hidden: [...this.localHidden()].filter(id => !this.entries.get(id)?.remindOnPaneFocus),
    };
  }

  /**
   * Which saved machine holds this card, and the id that machine knows it by; null for this
   * machine's own card. Its commands go to that machine.
   */
  remoteTarget(key: string): { machineId: string; machine: string; online: boolean; id: string; ui?: NotifyItem['ui'] } | null {
    for (const remote of this.remotes.values()) {
      if (!remote.items.has(key)) continue;
      return { machineId: remote.machineId, machine: remote.machine, online: remote.online, id: key.slice(remote.machineId.length + 1), ui: remote.items.get(key)?.ui };
    }
    return null;
  }

  /** Each saved machine this screen follows, and whether it answers. */
  savedMachines(): Array<{ machineId: string; machine: string; online: boolean }> {
    return [...this.remotes.values()].map(({ machineId, machine, online }) => ({ machineId, machine, online }));
  }

  /** This screen is sending (or failed to send) an answer for another machine's question; its card reads "Sent to". */
  noteAnsweredHere(key: string, answered: boolean): void {
    if (answered) this.answeredHere.add(key);
    else this.answeredHere.delete(key);
    this.changed();
  }

  /** An answer from this screen to another machine's question is on its way or in. */
  answeredHereAlready(key: string): boolean {
    return this.answeredHere.has(key);
  }

  /** "When I switch to Pane" for another machine's question: hidden here until this Pane comes to the front. */
  remindHere(key: string): void {
    if (![...this.remotes.values()].some(remote => remote.queue.includes(key))) return;
    this.remindedHere.add(key);
    this.changed();
  }

  /** The machine the app is on (`local` or a saved machine's id); other machines' cards offer no Open in Pane. */
  setActiveMachine(machineId: string): void {
    if (this.activeMachineId === machineId) return;
    this.activeMachineId = machineId;
    this.changed();
  }

  /**
   * One saved machine's shared state (null: no longer saved, so its cards go). `online: false`
   * keeps its questions showing but unanswerable. Each change plays out here as it does for this
   * machine's own questions: a chime, an update on the strip, a "Sent to" or "Answered on" hold,
   * an expiry.
   */
  /** A saved machine this screen will read; until it does, its cards count as not read yet. */
  expectRemote(machineId: string): void {
    if (!this.remotes.has(machineId)) this.unreadMachines.add(machineId);
  }

  /** Another machine's card this screen can't see yet: that machine is saved, but its questions haven't been read since launch. */
  notReadYet(key: string): boolean {
    for (const machineId of this.unreadMachines) if (key.startsWith(`${machineId}:`)) return true;
    return false;
  }

  setRemote(machineId: string, next: NotifyRemoteUpdate | null): void {
    const previous = this.remotes.get(machineId) ?? null;
    // A saved machine that is this computer (the same running Pane): its cards already show once.
    if (next?.state?.epoch === this.epoch) next = null;
    if (!next || next.state) this.unreadMachines.delete(machineId);
    if (!next) {
      if (!previous) return;
      if (this.transient && previous.items.has(this.transient.view.itemId)) this.clearTransient();
      this.remotes.delete(machineId);
      for (const set of [this.answeredHere, this.remindedHere]) {
        for (const key of [...set]) if (previous.items.has(key)) set.delete(key);
      }
      this.changed();
      return;
    }
    if (!next.state) {
      if (!previous) return;
      this.remotes.set(machineId, { ...previous, machine: next.machine, online: next.online, items: withMachine(previous.items, next.machine) });
      this.changed();
      return;
    }
    const state = next.state;
    // A snapshot read can land after a newer event; the machine's revision says which is current.
    if (previous && previous.epoch === state.epoch && state.revision < previous.revision) {
      if (previous.online !== next.online) this.setRemote(machineId, { machine: previous.machine, online: next.online });
      return;
    }
    const machine = next.machine;
    // The card key, as the glasses key cards: `<machineId>:<id>`.
    const key = (id: string) => `${machineId}:${id}`;
    const keyed = state.items.map(item => ({ ...item, id: key(item.id), machine, machineId }));
    const items = new Map(keyed.map(item => [item.id, item]));
    const queue = state.queue.map(key);
    const stripId = this.strip()?.itemId;
    this.remotes.set(machineId, {
      machineId, machine, hostName: state.machine, online: next.online, epoch: state.epoch, revision: state.revision,
      items, queue, hidden: new Set(state.hidden.map(key)),
    });
    // The first state after connecting shows what is already there, without a chime per question.
    const announce = previous !== null;
    for (const item of keyed) {
      const before = previous?.items.get(item.id);
      if (!before) {
        if (!announce) continue;
        if (item.state === 'waiting') {
          if (this.transient?.view.kind === 'info') this.clearTransient();
          // The computer you're using rings for every machine's items (D-144), but not for what's quiet or stale.
          if (!item.quiet && item.staleSince === undefined && !item.relay) this.chime();
        } else if (item.state === 'info') {
          const current = this.strip();
          if (this.canShowStrip() && (current === null || current.kind === 'info')) this.showInfo(item.id);
        }
        continue;
      }
      if (before.quiet && !item.quiet && item.state === 'waiting' && item.staleSince === undefined) this.chime();
      if (before.state === 'waiting' && item.state === 'sent' && (this.answeredHere.has(item.id) || stripId === item.id)) {
        this.setTransient({ kind: 'sent', itemId: item.id }, NOTIFY_UNDO_MS);
      } else if (before.state === 'sent' && item.state === 'waiting') {
        this.answeredHere.delete(item.id);
        if (this.transient?.view.itemId === item.id) this.clearTransient();
      } else if (before.state === 'sent' && item.state === 'answered') {
        // The host delivered it; Undo can no longer take it back here either.
        if (this.transient?.view.itemId === item.id) this.clearTransient();
      } else if (isOpen(before) && item.state === 'expired') {
        // Notify turned off on the host clears its questions quietly, as it does on the host's screen.
        if (stripId === item.id && state.enabled) this.setTransient({ kind: 'expired', itemId: item.id }, NOTIFY_EXPIRED_SHOW_MS);
        else if (this.transient?.view.itemId === item.id) this.clearTransient();
      }
    }
    const ours = (id: string) => id.startsWith(`${machineId}:`);
    for (const id of [...this.answeredHere]) if (ours(id) && (!items.has(id) || !isOpen(items.get(id)!))) this.answeredHere.delete(id);
    for (const id of [...this.remindedHere]) if (ours(id) && !queue.includes(id)) this.remindedHere.delete(id);
    if (this.transient && previous?.items.has(this.transient.view.itemId) && !items.has(this.transient.view.itemId)) this.clearTransient();
    this.changed();
  }

  setPaneFocused(focused: boolean): void {
    if (this.paneFocused === focused) return;
    this.paneFocused = focused;
    if (focused) {
      this.remindedHere.clear();
      for (const entry of this.entries.values()) {
        if (!entry.remindOnPaneFocus) continue;
        entry.remindOnPaneFocus = false;
        this.hidden.delete(entry.item.id);
      }
    }
    this.changed();
  }

  setRoundOpen(open: boolean): void {
    if (this.roundOpen === open) return;
    this.roundOpen = open;
    this.changed();
  }

  /** The panel's agent went idle at its prompt (or back to work) while it may have a call open. */
  panelStatus(panelId: string, idle: boolean): void {
    for (const entry of this.entries.values()) {
      // Only an open call can be abandoned: a saved item with no call is waiting on its tab's answer.
      if (entry.item.source.panelId !== panelId || !isOpen(entry.item) || !entry.waiter) continue;
      clearTimeout(entry.idleTimer);
      entry.idleTimer = idle ? setTimeout(() => this.expire(entry.item.id), NOTIFY_IDLE_BACKSTOP_MS) : undefined;
    }
  }

  /**
   * These tabs were paused: their open cards are withdrawn and their agents get `unavailable`.
   * The agent that asked was stopped, so a card never comes back on resume; it asks again if it still needs to.
   */
  withdrawForPanels(panelIds: readonly string[]): void {
    let withdrawn = false;
    for (const entry of [...this.entries.values()]) {
      const panelId = entry.item.source.panelId;
      if (panelId && panelIds.includes(panelId) && isOpen(entry.item)) {
        this.expire(entry.item.id, unavailable('Its tab was paused in Pane.'), false);
        // Hidden, not moved to Earlier today: a paused Pane leaves nothing behind in Notify.
        this.entries.delete(entry.item.id);
        withdrawn = true;
      }
    }
    if (withdrawn) this.changed();
  }

  /** Whether any of these tabs has a card still waiting on the person. */
  hasOpenFor(panelIds: readonly string[]): boolean {
    for (const entry of this.entries.values()) {
      const panelId = entry.item.source.panelId;
      if (panelId && panelIds.includes(panelId) && isOpen(entry.item)) return true;
    }
    return false;
  }

  /** Notify was turned off: every waiting agent gets `unavailable` and every surface clears. */
  turnOff(): void {
    for (const entry of [...this.entries.values()]) {
      // A saved item with no call stays saved, unseen, and comes back when Approvals does.
      if (isOpen(entry.item) && (entry.waiter || entry.resumeLoop)) this.close(entry.item.id, { state: 'expired', closed: { by: 'pane', reason: 'Approvals were turned off', at: Date.now() } }, unavailable('Approvals were turned off in Pane.'), false);
    }
    this.clearTransient();
    this.changed();
  }

  /**
   * An agent prompt's agent stopped waiting on Pane, but its terminal still asks: the question stays
   * waiting, without choices, until `settle` closes it. An answer still in its Undo hold never
   * reached the agent, so it is dropped and the question waits on the terminal again.
   */
  handOver(id: string): void {
    const entry = this.entries.get(id);
    if (!entry?.item.agentPrompt || !isOpen(entry.item) || entry.item.agentPrompt.inTerminal) return;
    if (entry.item.state === 'sent') this.reopen(entry);
    entry.item.agentPrompt = { ...entry.item.agentPrompt, inTerminal: true };
    this.changed();
  }

  /**
   * An agent prompt was answered where Pane can't see the choice (its terminal): it moves to
   * Earlier today with `summary`. An answer still in its Undo hold never reached the agent, so it
   * is dropped; one already delivered stands.
   */
  settle(id: string, summary: string): void {
    const entry = this.entries.get(id);
    if (!entry || !isOpen(entry.item)) return;
    entry.item.answeredOn = undefined;
    entry.item.delivered = { via: 'call', at: Date.now() };
    this.close(id, { state: 'answered', summary }, unavailable(summary), false);
  }

  /** Pane is about to end every call: from here on, one ending doesn't close its item. */
  prepareForQuit(): void {
    this.quitting = true;
  }

  /** Pane is quitting: release every open call. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      // The item stays saved: its asker's tab takes the answer after the restart (J6).
      if (isOpen(entry.item)) entry.waiter?.resolve(unavailable('Pane quit.'));
      clearEntryTimers(entry);
    }
    clearTimeout(this.pauseTimer);
    this.clearTransient();
  }

  /** Whether the Answer-all round has anything to show: stale and quiet items never come up (F-6). */
  hasWaiting(): boolean {
    return this.roundQueue().length > 0;
  }

  waitingItems(): NotifyItem[] {
    return this.allQueued().flatMap(id => this.find(id) ?? []);
  }

  snapshot(): NotifySnapshot {
    this.pruneOld();
    const strip = this.strip();
    const remotes = [...this.remotes.values()];
    const local = this.localItems();
    return {
      settings: this.env.settings(),
      items: remotes.length > 0
        ? [
          ...local.map(item => ({ ...withDeviceLabels(item, device => this.deviceLabel(device)), machine: this.machine(), machineId: LOCAL_MACHINE })),
          ...remotes.flatMap(remote => [...remote.items.values()].map(item => {
            const sentHere = this.answeredHere.has(item.id);
            const shown: NotifyItem = {
              ...withDeviceLabels(item, device => this.deviceLabel(device)),
              answeredOn: sentHere ? undefined : this.deviceLabel(item.answeredOn),
              unreachable: remote.online ? undefined : true,
              elsewhere: remote.machineId === this.activeMachineId ? undefined : true,
            };
            // Sent from here, before the machine says so: the card reads "Sent to" and can't be answered twice.
            if (sentHere && item.state === 'waiting') shown.state = 'sent';
            return shown;
          })),
        ]
        : local,
      queue: this.roundQueue(),
      hidden: [...this.allHidden()],
      strip,
      stripSurface: this.stripSurface(strip),
      pausedUntil: this.isPaused() ? this.pausedUntil : null,
      shortcutRegistered: this.env.shortcutRegistered(),
      showOutsideSupported: this.env.showOutsideSupported,
      instructionFiles: this.env.instructionFiles(),
      firstRun: strip?.kind === 'question' && (this.hintItemId === undefined || this.hintItemId === strip.itemId),
      importError: this.importError,
    };
  }

  /** The saved approvals couldn't be imported on this start; Approvals says so. */
  setImportError(error: { code: string; message: string; next: string } | undefined): void {
    this.importError = error;
    this.changed();
  }

  /** A strip is on screen; the first question shown keeps the first-run hint. */
  noteStripShown(): void {
    const strip = this.strip();
    if (this.hintItemId === undefined && strip?.kind === 'question') this.hintItemId = strip.itemId;
  }

  private resume(id: string, returnAfterMs: number | undefined, signal?: AbortSignal): Promise<NotifyResult> {
    const entry = this.entries.get(id);
    if (entry?.pending) {
      const result = entry.pending;
      entry.pending = undefined;
      clearTimeout(entry.graceTimer);
      return Promise.resolve(result);
    }
    if (!entry || !isOpen(entry.item)) {
      return Promise.resolve(unavailable('That question is no longer waiting: it was answered, closed or expired.'));
    }
    clearTimeout(entry.graceTimer);
    return this.wait(entry, returnAfterMs, signal);
  }

  private wait(entry: Entry, returnAfterMs: number | undefined, signal?: AbortSignal): Promise<NotifyResult> {
    // One call waits per question: an overlapping resume takes over, and the older call returns.
    entry.waiter?.resolve(unavailable('Another notify call is now waiting on this question.'));
    return new Promise((resolve) => {
      let returnTimer: Timer | undefined;
      const onAbort = () => {
        // Pane stopping its server ends every call; that isn't the asker leaving (J6).
        if (entry.waiter === waiter && !this.quitting) this.expire(entry.item.id);
      };
      const waiter: Waiter = {
        resolve: (result) => {
          waiter.detach();
          resolve(result);
        },
        detach: () => {
          clearTimeout(returnTimer);
          signal?.removeEventListener('abort', onAbort);
          if (entry.waiter === waiter) entry.waiter = undefined;
        },
      };
      entry.waiter = waiter;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (returnAfterMs !== undefined && returnAfterMs > 0) {
        const remaining = entry.item.createdAt + NOTIFY_RESUME_CAP_MS - Date.now();
        returnTimer = setTimeout(() => {
          if (remaining <= returnAfterMs) {
            // An answer in its Undo hold reaches this call when the hold ends.
            if (entry.item.state === 'sent') return;
            this.expire(entry.item.id, unavailable('Nobody answered within 15 minutes.'));
            return;
          }
          entry.resumeLoop = true;
          waiter.resolve({
            waiting: true,
            id: entry.item.id,
            next: `Call \`runpane notify --resume ${entry.item.id}\` now to keep waiting for the answer.`,
          });
          entry.graceTimer = setTimeout(() => this.expire(entry.item.id), NOTIFY_RESUME_GRACE_MS);
        }, Math.min(returnAfterMs, Math.max(remaining, 0)));
      }
    });
  }

  private answer(id: string, answer: NotifyAnswer, device?: string): void | Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.item.state !== 'waiting') return;
    if (entry.item.agentPrompt?.inTerminal) {
      throw new PaneError('ERR_NOTIFY_IN_TERMINAL', `${entry.item.source.agent} stopped waiting on Pane and is asking in its terminal now. Nothing was sent.`, 'Open the tab and answer in the terminal.');
    }
    if (entry.item.ui === 'secret') return this.answerSecret(entry, answer, device);
    const result = toResult(entry.item, answer);
    const before = { ...entry.item };
    entry.item.state = 'sent';
    entry.item.answerSummary = summarize(entry.item, result);
    entry.item.answeredOn = device;
    entry.item.answeredBy = { by: 'you' };
    entry.item.quiet = undefined;
    if (!this.claimRow(entry, before)) throw this.alreadyEnded(entry.item);
    this.queue = this.queue.filter(other => other !== id);
    this.hidden.delete(id);
    endReminder(entry);
    entry.holdTimer = setTimeout(() => this.deliver(entry, result), NOTIFY_UNDO_MS);
    this.setTransient({ kind: 'sent', itemId: id }, NOTIFY_UNDO_MS);
    this.changed();
  }

  /**
   * A secret card's value goes to the secret store and nowhere else: not the result, the
   * summary, the snapshot, history or the Undo hold. The agent gets `{status:'saved'}` at
   * once, since a saved value cannot be taken back by Undo. A failed save keeps the card
   * waiting, with the reason on it, so the person can try again.
   */
  private async answerSecret(entry: Entry, answer: NotifyAnswer, device?: string): Promise<void> {
    const target = entry.item.secret;
    if (!target || !this.env.secrets) throw new Error('This card has nowhere to save a secret.');
    // A value is being saved: the card ends as saved, so a Decline now would contradict it.
    if (entry.saving) return;
    if ('approved' in answer && !answer.approved) {
      this.finishSecret(entry, { status: 'declined' }, 'Declined', device);
      return;
    }
    if (!('text' in answer) || !answer.text) throw new Error('A secret card takes the secret value, or Decline.');
    entry.saving = true;
    try {
      await this.env.secrets.save(target.project, target.name, answer.text);
    } catch (error) {
      entry.saving = false;
      if (entry.item.state !== 'waiting') return;
      entry.item.secretError = error instanceof PaneError && error.next ? `${error.message} ${error.next}` : error instanceof Error ? error.message : String(error);
      this.changed();
      throw error;
    }
    entry.saving = false;
    if (entry.item.state !== 'waiting') return;
    this.finishSecret(entry, { status: 'saved', project: target.project, name: target.name }, `Saved as ${target.project}/${target.name}`, device);
  }

  private finishSecret(entry: Entry, result: NotifyResult, summary: string, device?: string): void {
    const id = entry.item.id;
    delete entry.item.secretError;
    entry.item.answerSummary = summary;
    entry.item.answeredOn = device;
    this.queue = this.queue.filter(other => other !== id);
    this.hidden.delete(id);
    endReminder(entry);
    this.deliver(entry, result);
  }

  private deliver(entry: Entry, result: NotifyResult): void {
    entry.holdTimer = undefined;
    entry.item.state = 'answered';
    entry.item.resolvedAt = Date.now();
    clearTimeout(entry.idleTimer);
    this.handOverAnswer(entry, result);
    this.trimHistory();
    this.changed();
  }

  private undo(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.item.state !== 'sent') return;
    this.reopen(entry);
    this.changed();
  }

  /** Cancels an answer in its Undo hold: the question waits again, first in line. */
  private reopen(entry: Entry): void {
    const id = entry.item.id;
    clearTimeout(entry.holdTimer);
    entry.holdTimer = undefined;
    entry.item.state = 'waiting';
    entry.item.answerSummary = undefined;
    entry.item.answeredOn = undefined;
    entry.item.answeredBy = undefined;
    this.save(entry);
    this.queue = [id, ...this.queue];
    if (this.transient?.view.itemId === id) this.clearTransient();
  }

  /** The caller stopped waiting: the card says so, then moves to Earlier today as Expired. */
  private expire(id: string, result?: NotifyResult, announce = true): void {
    this.close(id, { state: 'expired', closed: { by: 'pane', reason: ASKER_STOPPED, at: Date.now() } }, result ?? unavailable('The question expired.'), announce);
  }

  /** Ends an open question as `outcome` and returns `result` to its caller; `announce` shows an expiry on the strip. */
  private close(id: string, outcome: { state: 'expired' | 'answered'; summary?: string; closed?: NotifyClosed }, result: NotifyResult, announce: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || !isOpen(entry.item)) return;
    const wasOnStrip = this.strip()?.itemId === id;
    clearEntryTimers(entry);
    entry.item.state = outcome.state;
    entry.item.resolvedAt = Date.now();
    entry.item.answerSummary = outcome.summary;
    entry.item.quiet = undefined;
    if (outcome.closed) entry.item.closed = outcome.closed;
    this.save(entry);
    this.queue = this.queue.filter(other => other !== id);
    this.hidden.delete(id);
    entry.waiter?.resolve(result);
    if (announce && wasOnStrip) this.setTransient({ kind: 'expired', itemId: id }, NOTIFY_EXPIRED_SHOW_MS);
    else if (this.transient?.view.itemId === id) this.clearTransient();
    this.trimHistory();
    this.changed();
  }

  private hide(id: string): void {
    if (!this.queue.includes(id)) {
      if (this.transient?.view.itemId === id) {
        this.clearTransient();
        this.changed();
      }
      return;
    }
    this.hidden.add(id);
    const entry = this.entries.get(id);
    if (entry) endReminder(entry);
    this.changed();
  }

  private remind(id: string, after: NotifyRemindAfter): void {
    const entry = this.entries.get(id);
    if (!entry || !this.queue.includes(id)) return;
    this.hidden.add(id);
    endReminder(entry);
    entry.remindOnPaneFocus = after === 'pane';
    if (after !== 'pane') {
      entry.item.snoozedUntil = Date.now() + REMIND_AFTER_MS[after];
      entry.remindTimer = setTimeout(() => {
        entry.item.snoozedUntil = undefined;
        this.hidden.delete(id);
        this.changed();
      }, REMIND_AFTER_MS[after]);
    }
    this.changed();
  }

  private skip(id: string): void {
    if (!this.queue.includes(id)) return;
    this.queue = [...this.queue.filter(other => other !== id), id];
    this.changed();
  }

  private showInfo(id: string): void {
    const hideAfterMs = this.env.settings().updatesHideAfterSeconds * 1000;
    this.setTransient({ kind: 'info', itemId: id, hideAt: Date.now() + hideAfterMs }, hideAfterMs);
  }

  private hoverInfo(id: string, hovering: boolean): void {
    const view = this.transient?.view;
    if (view?.kind !== 'info' || view.itemId !== id) return;
    if (hovering) this.setTransient({ kind: 'info', itemId: id, hideAt: null });
    else this.showInfo(id);
    this.changed();
  }

  private pause(minutes: number): void {
    clearTimeout(this.pauseTimer);
    this.pausedUntil = Date.now() + minutes * 60_000;
    this.pauseTimer = setTimeout(() => this.unpause(), minutes * 60_000);
    this.changed();
  }

  private unpause(): void {
    clearTimeout(this.pauseTimer);
    this.pausedUntil = null;
    this.changed();
  }

  private isPaused(): boolean {
    return this.pausedUntil !== null && this.pausedUntil > Date.now();
  }

  private setTransient(view: NotifyStripView, ms?: number): void {
    clearTimeout(this.transient?.timer);
    const timer = ms === undefined ? undefined : setTimeout(() => {
      if (this.transient?.view !== view) return;
      this.transient = null;
      this.changed();
    }, ms);
    this.transient = { view, timer };
  }

  private clearTransient(): void {
    clearTimeout(this.transient?.timer);
    this.transient = null;
  }

  /** What the strip shows: a confirmation, expiry or update first, else the oldest visible question. */
  private strip(): NotifyStripView | null {
    if (this.transient) return this.transient.view;
    const hidden = this.allHidden();
    const id = this.allQueued().find(other => !hidden.has(other));
    return id ? { kind: 'question', itemId: id } : null;
  }

  /** Files the item under its Pane's Session, unless the asker already named one. */
  private withSession(source: NotifySource): NotifySource {
    if (!source.paneId) return source;
    const project = source.project ?? this.env.projectOf?.(source.paneId);
    const session = source.session ?? this.env.sessionOf?.(source.paneId, source.panelId);
    return { ...source, ...(session && { session }), ...(project && { project }) };
  }

  private find(id: string): NotifyItem | undefined {
    const local = this.entries.get(id)?.item;
    if (local) return local;
    for (const remote of this.remotes.values()) {
      const item = remote.items.get(id);
      if (item) return item;
    }
    return undefined;
  }

  /** Every machine's waiting questions, oldest first; each machine keeps its own order (skip moves one back). */
  private allQueued(): string[] {
    const queues = [this.localQueue(), ...[...this.remotes.values()].map(remote => remote.queue.filter(id => !this.answeredHere.has(id)))].filter(queue => queue.length > 0);
    if (queues.length <= 1) return [...queues[0] ?? []];
    const heads = queues.map(() => 0);
    const merged: string[] = [];
    for (;;) {
      let pick = -1;
      let pickAt = Infinity;
      queues.forEach((queue, index) => {
        if (heads[index] >= queue.length) return;
        const at = this.find(queue[heads[index]])?.createdAt ?? Infinity;
        if (pick === -1 || at < pickAt) { pick = index; pickAt = at; }
      });
      if (pick === -1) return merged;
      merged.push(queues[pick][heads[pick]++]);
    }
  }

  /** What the round and the strip's "1 of N" walk: every machine's waiting items, less stale and quiet ones, as the counts are. */
  private roundQueue(): string[] {
    return this.allQueued().filter((id) => {
      const item = this.find(id);
      return item !== undefined && item.staleSince === undefined && !item.quiet;
    });
  }

  private allHidden(): Set<string> {
    if (this.remotes.size === 0) return this.localHidden();
    return new Set([...this.localHidden(), ...[...this.remotes.values()].flatMap(remote => [...remote.hidden]), ...this.remindedHere]);
  }

  /** The device on a receipt, as this screen's picker names it: this computer's is no label at all. */
  private deviceLabel(device: string | undefined): string | undefined {
    if (!device || device === this.machine()) return undefined;
    for (const remote of this.remotes.values()) if (remote.hostName === device) return remote.machine;
    return device;
  }

  private machine(): string {
    return this.env.machine ?? 'this computer';
  }

  private canShowStrip(): boolean {
    const settings = this.env.settings();
    if (!settings.enabled || this.isPaused() || this.roundOpen || !this.inUse()) return false;
    return this.paneFocused || (settings.showOutsidePane && this.env.showOutsideSupported);
  }

  private stripSurface(strip: NotifyStripView | null): NotifySnapshot['stripSurface'] {
    if (!strip || !this.canShowStrip()) return null;
    return this.paneFocused ? 'pane' : 'window';
  }

  private trimHistory(): void {
    const done = [...this.entries.values()].filter(entry => !isOpen(entry.item));
    for (const entry of done.slice(0, Math.max(0, done.length - HISTORY_LIMIT))) this.entries.delete(entry.item.id);
  }

  /** The Answered list and For your information hold the last 24 hours; the store keeps the record. */
  private pruneOld(): boolean {
    const since = Date.now() - HISTORY_MS;
    let pruned = false;
    for (const entry of [...this.entries.values()]) {
      const at = entry.item.resolvedAt ?? entry.item.createdAt;
      if (!isOpen(entry.item) && at < since && this.transient?.view.itemId !== entry.item.id) {
        this.entries.delete(entry.item.id);
        pruned = true;
      }
    }
    return pruned;
  }

  private changed(): void {
    this.revision += 1;
    this.emit('change');
  }
}

/** An item's receipts naming devices as this screen's picker does. */
function withDeviceLabels(item: NotifyItem, label: (device: string | undefined) => string | undefined): NotifyItem {
  const labelled = { ...item, answeredOn: label(item.answeredOn) };
  if (item.reopened) labelled.reopened = { ...item.reopened, device: label(item.reopened.device) };
  return labelled;
}

/** A machine's items under its current name, after a rename. */
function withMachine(items: Map<string, NotifyItem>, machine: string): Map<string, NotifyItem> {
  return new Map([...items].map(([key, item]) => [key, item.machine === machine ? item : { ...item, machine }]));
}

function isOpen(item: NotifyItem): boolean {
  return item.state === 'waiting' || item.state === 'sent';
}

function clearEntryTimers(entry: Entry): void {
  clearTimeout(entry.holdTimer);
  clearTimeout(entry.graceTimer);
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.ringTimer);
  endReminder(entry);
}

/** Cancels a snooze or reminder; the question stays where it is. */
function endReminder(entry: Entry): void {
  clearTimeout(entry.remindTimer);
  entry.remindOnPaneFocus = false;
  entry.item.snoozedUntil = undefined;
}

/** A question that was closed: asking it somewhere else is the one thing not to do. */
function closedResult(reason: string): NotifyResult {
  return { unavailable: reason, next: "Carry on without it. Ask again only if something has changed." };
}

function unavailable(reason: string): NotifyResult {
  return { unavailable: reason, next: ASK_IN_TERMINAL };
}

/** How the asker recognises its question in a typed line: its Q-n, else its title. */
function askerRef(item: NotifyItem): string {
  return leadingQn(item.title) ?? `"${item.title.length > 80 ? `${item.title.slice(0, 79)}…` : item.title}"`;
}

/** The line a tab receives: `answer: Q-39 → Yes (by you)`. */
function answerLine(item: NotifyItem): string {
  const by = item.answeredBy?.by === 'autopilot' ? 'Autopilot' : item.answeredBy?.by === 'orchestrator' ? 'the orchestrator' : 'you';
  return `answer: ${askerRef(item)} → ${item.answerSummary ?? ''} (by ${by})`;
}

function toResult(item: NotifyItem, answer: NotifyAnswer): NotifyResult {
  const note = 'note' in answer && answer.note?.trim() ? answer.note.trim() : undefined;
  if (item.ui === 'approve' && 'approved' in answer) return note ? { approved: answer.approved, note } : { approved: answer.approved };
  if (item.ui === 'options' && 'choice' in answer && item.choices?.some(choice => choice.label === answer.choice)) {
    return note ? { answer: answer.choice, note } : { answer: answer.choice };
  }
  if ((item.ui === 'ask' || item.ui === 'options') && 'text' in answer && answer.text.trim()) {
    // A spoken or typed reply to an options question names a choice, or answers in its own words.
    const text = answer.text.trim();
    const choice = item.choices?.find(candidate => spokenForm(candidate.label) === spokenForm(text));
    return { answer: choice?.label ?? text };
  }
  throw new Error(`That answer doesn't fit this ${item.ui} question.`);
}

/** Dictation capitalizes and ends with a period: "Keep redis." names "Keep Redis". */
function spokenForm(text: string): string {
  return text.trim().replace(/[.!?]+$/, '').toLowerCase();
}

function summarize(item: NotifyItem, result: NotifyResult): string {
  if ('approved' in result) return result.approved ? 'Approved' : 'Denied';
  if ('answer' in result) return result.answer;
  return item.title;
}
