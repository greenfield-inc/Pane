import { EventEmitter } from 'events';
import { PaneError } from '../../../../shared/paneError';
import { messageRef, type AgentMessageParty, type AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { AGENT_MESSAGE_RETENTION_MS, messageRecord, type AgentMessageStore, type MessagePointer, type StoredMessage } from './agentMessageStore';
import { replyLine, withReplyRoute } from './agentMessageText';

export type MessageTypeResult = 'delivered' | 'busy' | 'gone' | 'unsupported' | 'outdated';

/** A tab as messages see it: who it is, and whether an agent runs in it (a shell tab is the person). */
export interface MessagePanelInfo extends AgentMessageParty {
  panelId: string;
  agent: boolean;
}

/** What the service needs from the running Pane; tests pass a fake. */
export interface AgentMessageHost {
  panel(panelId: string): MessagePanelInfo | null;
  /** A Session's orchestrator tab now (it changes when the Session switches agent or to chat). */
  orchestratorPanel(sessionId: string): string | null;
  isPanelDown(panelId: string): Promise<boolean>;
  resumePanel(panelId: string): Promise<boolean>;
  isMidTurn(panelId: string): boolean;
  hasUnsentText(panelId: string): Promise<boolean>;
  /** Types into a tab only at a live agent's prompt (typeIntoLocalTab). */
  typeIntoTab(panelId: string, text: string): Promise<MessageTypeResult>;
  log(message: string, error?: Error | string): void;
}

/** One message and its replies, as `runpane messages show` reads them. */
export interface MessageThread {
  message: AgentMessageRecord;
  replies: AgentMessageRecord[];
}

/** A message `panels submit` is about to type: its id, the text with the reply line, and its prompt file (a file-pointer send). */
export interface OutgoingMessage {
  number: number;
  ref: string;
  text: string;
  pointer: MessagePointer | null;
}

const RESUME_TRIES = 3;
/** Passes one flush makes when replies' routes keep moving under it; the 3s timer picks up the rest. */
const MAX_REROUTE_PASSES = 3;
/** The prefix Autopilot's relay of the person's own words starts with: those words are the person's, not Autopilot's. */
const PERSON_RELAY_PREFIX = '[From the person, via Autopilot]';
const MAX_REPLY_CHARS = 8000;
const PERSON: AgentMessageParty = { panelId: null, paneId: null, sessionId: null, name: 'the person', orchestrator: false };

const UNDELIVERED = {
  gone: 'its tab closed',
  unsupported: 'its tab takes no typed messages here',
  outdated: 'its Pane is too old to take it',
} as const satisfies Record<Exclude<MessageTypeResult, 'delivered' | 'busy'>, string>;

function party(info: MessagePanelInfo): AgentMessageParty {
  return { panelId: info.panelId, paneId: info.paneId, sessionId: info.sessionId, name: info.name, orchestrator: info.orchestrator };
}

/**
 * Agent-to-agent messages (T-104). `panels submit` from one agent's tab to another records the
 * message (M-n) and ends it with a reply line; `runpane reply M-n` records the answer and types it
 * into the sender's tab, the way to-do messages reach theirs: only at a live agent's prompt,
 * resuming a tab that is down, and following a Session's orchestrator to its current tab. Every
 * reply is typed into that tab; `--await-reply` and `messages wait` only watch for it and return it
 * too (the receiver acts on it once, from whichever comes first, as with notify answers). Emits `changed`.
 */
export class AgentMessageService extends EventEmitter {
  private readonly outbox: number[] = [];
  private readonly resumeFailures = new Map<number, number>();
  private flushing: Promise<void> | null = null;

  constructor(private readonly store: AgentMessageStore, private readonly host: AgentMessageHost, private readonly now: () => number = Date.now) {
    super();
    // Each waiting call listens for `changed`; there can be many at once.
    this.setMaxListeners(0);
  }

  /** Queues replies a restart left waiting, and drops messages past their keep time. */
  start(): void {
    this.store.prune(this.now() - AGENT_MESSAGE_RETENTION_MS);
    for (const reply of this.store.queued()) if (!this.outbox.includes(reply.number)) this.outbox.push(reply.number);
    void this.flush();
  }

  /**
   * Called by `panels submit` before it types. An agent's tab writing to another tab gets an id and
   * a reply line; the person (the app, a phone, a shell tab, `--source user`) and a tab writing to
   * itself get nothing, and their text goes as typed.
   */
  beginMessage(input: {
    callerPanelId: string | undefined; receiverPanelId: string; body: string; source?: 'user' | 'agent';
    /** The text is the person's own words an agent passes on (Autopilot's relay, `--for-person`). */
    personWords?: boolean;
    /** The submit's operation id: a replay of the same request gets the same message and text. */
    operationId?: string;
    /** What the submit asked for (text, file pointer, attachments); a replay must match it. Defaults to `body`. */
    requestKey?: string;
    /** The prompt file a file-pointer send wrote, kept so a replay returns the same paths. */
    pointer?: MessagePointer;
  }): OutgoingMessage | undefined {
    if (!input.callerPanelId || !this.isAgentMessage(input)) return undefined;
    const sender = this.host.panel(input.callerPanelId);
    const receiver = this.host.panel(input.receiverPanelId);
    if (!sender?.agent || !receiver) return undefined;
    const requestKey = input.requestKey ?? input.body;
    // Only the same request replays: the same operation id with other content is a new message, which a chat tab refuses (CHAT_OPERATION_CONFLICT).
    const replayed = input.operationId ? this.store.byOperation(input.operationId, input.callerPanelId, input.receiverPanelId, requestKey) : undefined;
    const message = replayed ?? this.store.create({
      kind: 'message', sender: party(sender), receiver: party(receiver), body: input.body, state: 'sending', now: this.now(),
      operationId: input.operationId, requestKey, pointer: input.pointer,
    });
    if (!replayed) this.changed();
    return { number: message.number, ref: messageRef(message.number), text: withReplyRoute(message.body, message.number, message.sender.name), pointer: message.pointer };
  }

  /**
   * The earlier send a replayed submit repeats: the same operation id, tabs and request. Its body and
   * prompt file are what the replay sends and returns, so no new file is written.
   */
  priorSend(input: { operationId: string | undefined; callerPanelId: string | undefined; receiverPanelId: string; requestKey: string }): { body: string; pointer: MessagePointer | null } | undefined {
    if (!input.operationId || !input.callerPanelId) return undefined;
    const prior = this.store.byOperation(input.operationId, input.callerPanelId, input.receiverPanelId, input.requestKey);
    return prior ? { body: prior.body, pointer: prior.pointer } : undefined;
  }

  /**
   * Whether `panels submit` would send this as an agent's message (beginMessage's rule), before
   * anything is recorded: a file-pointer send writes its prompt file first, then sends its line.
   */
  isAgentMessage(input: { callerPanelId: string | undefined; receiverPanelId: string; body: string; source?: 'user' | 'agent'; personWords?: boolean }): boolean {
    if (!input.callerPanelId || input.source === 'user' || input.callerPanelId === input.receiverPanelId || !input.body.trim()) return false;
    if (input.personWords || input.body.trimStart().startsWith(PERSON_RELAY_PREFIX)) return false;
    return this.host.panel(input.callerPanelId)?.agent === true && this.host.panel(input.receiverPanelId) !== null;
  }

  /** After `panels submit`: the message reached the tab, or it didn't and why. */
  finishMessage(number: number, outcome: { ok: true } | { ok: false; reason: string }): void {
    const message = this.store.get(number);
    // A replayed submit (same operation id) may succeed after its first try failed.
    if (!message || (message.state !== 'sending' && !(outcome.ok && message.state === 'undelivered'))) return;
    if (outcome.ok) this.store.markDelivered(number, this.now());
    else this.store.setState(number, 'undelivered', { reason: outcome.reason, at: this.now() });
    this.changed();
  }

  /** `runpane reply M-n "…"`: records the reply, marks the original answered, and sends it to the original's sender. */
  async reply(input: { to: number; body: string; callerPanelId: string | undefined }): Promise<{ reply: AgentMessageRecord; delivery: 'delivered' | 'queued' | 'undelivered' }> {
    const original = this.store.get(input.to);
    if (!original) {
      throw new PaneError('ERR_MESSAGE_NOT_FOUND', `There is no message ${messageRef(input.to)} on this computer, so nothing was sent.`, 'See recent messages with `runpane messages list`, then reply to one of those.');
    }
    const body = input.body.trim();
    if (!body) throw new PaneError('ERR_RUNPANE_INVALID_ARGUMENT', 'The reply is empty, so nothing was sent.', `Pass the reply in quotes: runpane reply ${messageRef(input.to)} "…".`);
    if (body.length > MAX_REPLY_CHARS) {
      throw new PaneError('ERR_RUNPANE_INVALID_ARGUMENT', `The reply is ${body.length} characters, over the ${MAX_REPLY_CHARS} a reply takes, so nothing was sent.`, 'Put the detail in a file, and reply with a short summary and its path.');
    }
    const caller = input.callerPanelId ? this.host.panel(input.callerPanelId) : null;
    // The reply goes back to whoever sent the original; its sender is whoever answers it (the person when no tab ran the command).
    const replier = caller ? party(caller) : input.callerPanelId ? original.receiver : PERSON;
    const reply = this.store.create({ kind: 'reply', replyTo: original.number, sender: replier, receiver: original.sender, body, state: 'queued', now: this.now() });
    this.store.setState(original.number, 'answered', { at: this.now() });
    this.outbox.push(reply.number);
    this.changed();
    await this.flush();
    const state = this.mustGet(reply.number).state;
    return { reply: this.record(reply.number), delivery: state === 'delivered' ? 'delivered' : state === 'undelivered' ? 'undelivered' : 'queued' };
  }

  /**
   * `--await-reply` and `messages wait`: resolves with the first reply to `number` as soon as it is
   * recorded (already there, or the next one), or undefined after `timeoutMs` or when `signal`
   * aborts. Read-only: the reply is typed into the sender's tab all the same, so the caller acts on
   * it once, from whichever reaches it first.
   */
  async waitForReply(number: number, timeoutMs: number | undefined, signal?: AbortSignal): Promise<AgentMessageRecord | undefined> {
    if (!this.store.get(number)) {
      throw new PaneError('ERR_MESSAGE_NOT_FOUND', `There is no message ${messageRef(number)} on this computer, so there is no reply to wait for.`, 'See recent messages with `runpane messages list`.');
    }
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (reply: AgentMessageRecord | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.off('changed', look);
        resolve(reply);
      };
      const abort = () => finish(undefined);
      const look = () => {
        const first = this.store.replies(number)[0];
        if (first) finish(this.record(first.number));
      };
      // Listen first, then look: a reply recorded in between still emits `changed`.
      this.on('changed', look);
      if (signal?.aborted) {
        abort();
        return;
      }
      if (timeoutMs !== undefined) timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      look();
    });
  }

  /** Newest first; `before` (a message number) pages further back, older than that message. */
  list(filter: { panelId?: string; limit?: number; before?: number } = {}): AgentMessageRecord[] {
    return this.store.list(filter).map(message => messageRecord(message, this.store.replyNumbers(message.number)));
  }

  show(number: number): MessageThread {
    const message = this.store.get(number);
    if (!message) throw new PaneError('ERR_MESSAGE_NOT_FOUND', `There is no message ${messageRef(number)} on this computer.`, 'See recent messages with `runpane messages list`.');
    return { message: this.record(number), replies: this.store.replies(number).map(reply => this.record(reply.number)) };
  }

  /** Replies waiting on a tab, for tests and the page. */
  queuedFor(panelId: string): AgentMessageRecord[] {
    return this.outbox.map(number => this.mustGet(number)).filter(reply => this.targetOf(reply) === panelId).map(reply => this.record(reply.number));
  }

  /** Types each queued reply into its tab at its prompt. Called on reply, when a tab goes idle, and by a timer. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    // A reply whose route moved mid-attempt (a Session handoff) is tried again at once, for its new tab.
    for (let pass = 0; pass < MAX_REROUTE_PASSES; pass += 1) {
      if (!await this.flushPass()) return;
    }
  }

  /** One pass over the outbox, one attempt per tab. True when an attempt found its reply's route had moved. */
  private async flushPass(): Promise<boolean> {
    let rerouted = false;
    const tried = new Set<string>();
    for (const number of [...this.outbox]) {
      const reply = this.store.get(number);
      if (!reply || reply.state !== 'queued') {
        this.dropFromOutbox(number);
        continue;
      }
      const target = this.targetOf(reply);
      if (!target) {
        this.settleUndelivered(reply, 'its tab closed');
        continue;
      }
      if (tried.has(target)) continue;
      tried.add(target);
      try {
        if (await this.deliver(reply, target) === 'rerouted') rerouted = true;
      } catch (error) {
        this.host.log(`[Messages] delivery of ${messageRef(number)} to ${target} failed`, error instanceof Error ? error : String(error));
      }
    }
    return rerouted;
  }

  /**
   * One attempt to type `reply` into `panelId`, the route it had when the pass began. The readiness
   * checks await, so the route is read again just before typing (and after a tab turns out gone): a
   * Session that switched orchestrator meanwhile gets the reply in its new tab, never the old one.
   */
  private async deliver(reply: StoredMessage, panelId: string): Promise<'rerouted' | undefined> {
    if (await this.host.isPanelDown(panelId)) {
      // Resume before delivery: the sender's tab is down after a restart. A resume that throws failed too.
      let why = 'it would not restart';
      let resumed = false;
      try {
        resumed = await this.host.resumePanel(panelId);
      } catch (error) {
        why = `it would not restart: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (resumed) this.resumeFailures.delete(reply.number);
      else this.resumeFailed(reply, why);
      return undefined;
    }
    if (this.host.isMidTurn(panelId) || await this.host.hasUnsentText(panelId)) return undefined;
    const current = this.store.get(reply.number);
    if (current?.state !== 'queued') return undefined;
    if (this.targetOf(current) !== panelId) return 'rerouted';
    const original = reply.replyTo === null ? undefined : this.store.get(reply.replyTo);
    const result = await this.host.typeIntoTab(panelId, replyLine(original?.number ?? reply.number, reply.number, reply.body, reply.sender.name));
    if (result === 'busy') return undefined;
    if (result !== 'delivered') {
      // The tab closed while it was typed into, and the Session has another orchestrator tab now: try that one.
      const moved = this.targetOf(current);
      if (result === 'gone' && moved !== null && moved !== panelId) return 'rerouted';
      this.settleUndelivered(reply, UNDELIVERED[result]);
      return undefined;
    }
    this.dropFromOutbox(reply.number);
    this.store.setState(reply.number, 'delivered', { via: 'tab', at: this.now() });
    this.changed();
    return undefined;
  }

  /**
   * Where a reply goes now. A message sent as a Session's orchestrator goes to the Session's
   * orchestrator tab now, even when the tab that sent it still exists (the Session switched agent);
   * any other goes to the tab that sent it.
   */
  private targetOf(reply: StoredMessage): string | null {
    const to = reply.receiver;
    if (to.orchestrator && to.sessionId) {
      const current = this.host.orchestratorPanel(to.sessionId);
      if (current && this.host.panel(current)) return current;
    }
    if (to.panelId && this.host.panel(to.panelId)) return to.panelId;
    return null;
  }

  private resumeFailed(reply: StoredMessage, why: string): void {
    const failures = (this.resumeFailures.get(reply.number) ?? 0) + 1;
    this.resumeFailures.set(reply.number, failures);
    if (failures < RESUME_TRIES) return;
    this.resumeFailures.delete(reply.number);
    this.settleUndelivered(reply, why);
  }

  private settleUndelivered(reply: StoredMessage, why: string): void {
    this.dropFromOutbox(reply.number);
    this.store.setState(reply.number, 'undelivered', { reason: why, at: this.now() });
    this.host.log(`[Messages] ${messageRef(reply.number)} can't reach ${reply.receiver.name}: ${why}`);
    this.changed();
  }

  private dropFromOutbox(number: number): void {
    const index = this.outbox.indexOf(number);
    if (index >= 0) this.outbox.splice(index, 1);
  }

  private mustGet(number: number): StoredMessage {
    const message = this.store.get(number);
    if (!message) throw new Error(`Message ${messageRef(number)} was written but could not be read back.`);
    return message;
  }

  private record(number: number): AgentMessageRecord {
    return messageRecord(this.mustGet(number), this.store.replyNumbers(number));
  }

  private changed(): void {
    this.emit('changed');
  }
}
