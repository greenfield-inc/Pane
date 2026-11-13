import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PaneError } from '../../../../shared/paneError';
import type { ChatPanelState, ChatTabLaunch } from '../../../../shared/types/chatTab';
import type { NotifyItem, NotifyQuestion, NotifyResult } from '../../../../shared/types/notify';
import {
  AUTOPILOT_OWNER_PANE_PREFIX,
  AUTOPILOT_PANEL_PREFIX,
  type AutopilotAgentState,
  type AutopilotInstructionsView,
  type AutopilotRunInfo,
  type AutopilotSnapshot,
  type AutopilotStack,
  type AutopilotStackEntry,
  type AutopilotStackPushRequest,
  type AutopilotTab,
  type AutopilotWaitingItem,
  type AutopilotWalk,
} from '../../../../shared/types/autopilot';
import { AutopilotStore, type AutopilotRunState } from './autopilotStore';
import { pushEntry, resolveEntries, sameRef, showEntry, shownEntry, stepStack } from './autopilotStack';
import { assertAutopilotEntitled, autopilotEntitlement } from './entitlement';
import { autopilotInstructions, OWN_INSTRUCTIONS_LABEL } from './autopilotInstructions';
import { DEFAULT_AGENT_ID } from '../../../../shared/agents';

/** A Session as the walk sees it, in sidebar order. */
/** What a push did: the snapshot after it, and the entry it made or refreshed. */
export interface AutopilotStackPushOutcome {
  snapshot: AutopilotSnapshot;
  entry: AutopilotStackEntry;
}

export interface AutopilotSessionInfo {
  id: string;
  name: string;
  archived?: boolean;
  /** The Session's hidden owner Pane (its orchestrator tabs live there). */
  paneId: string;
}

/** Who made a control-plane call: the Pane and tab whose agent ran the command. Absent: the person (Pane's own UI). */
export interface AutopilotCaller {
  paneId?: string;
  panelId?: string;
}

/** What the manager needs from the rest of Pane; tests pass fakes. */
export interface AutopilotPorts {
  root: string;
  config: {
    autopilotEnabled(): boolean;
    chatTabsEnabled(): boolean;
    setAutopilotEnabled(enabled: boolean): Promise<void>;
  };
  /** The hidden, detached owner Pane of a run (no project, no Session association). */
  owner: {
    exists(paneId: string): boolean;
    create(paneId: string, title: string, folder: string): void;
  };
  chat: {
    exists(panelId: string): boolean;
    create(panelId: string, ownerPaneId: string, title: string, state: ChatPanelState): Promise<void>;
    ensure(panelId: string): Promise<void>;
    isRunning(panelId: string): boolean;
    send(panelId: string, text: string): void;
    /** Ends the agent and leaves the tab stopped (with the given reason), keeping its conversation. */
    stop(panelId: string, message: string, next: string): Promise<void>;
    /**
     * Starts a stopped tab only to reload its conversation (the agent resumes its session; no turn runs).
     * False, leaving it stopped, when it has no session yet or the person's messages wait in its queue.
     */
    resume(panelId: string): Promise<boolean>;
    /** The agent is mid-turn or waiting on a prompt. */
    isBusy(panelId: string): boolean;
    /** Removes queued, not yet sent prompts whose text matches; returns how many. */
    unqueueWhere(panelId: string, match: (text: string) => boolean): number;
    /** Calls `listener` with a chat tab's id whenever its agent's status changes (started, idle, stopped, exited). */
    subscribe?(listener: (panelId: string) => void): () => void;
  };
  notify: {
    /** Every item the Approvals snapshot holds (this machine's and saved machines'). */
    items(): NotifyItem[];
    /** An item of a saved machine whose questions haven't been read since launch (offline, say): missing, not gone. */
    notReadYet(id: string): boolean;
    subscribe(listener: () => void): () => void;
    /** Asks the person through Notify (so it reaches their phone as a push); resolves with their answer. Aborting withdraws the card. */
    ask(question: NotifyQuestion, signal?: AbortSignal): Promise<NotifyResult>;
  };
  /** Runs `run` every `ms` until the returned stop is called (tests pass their own clock). */
  every?: (ms: number, run: () => void) => () => void;
  /** Runs `run` once after `ms` unless the returned cancel is called first (tests pass their own clock). */
  after?: (ms: number, run: () => void) => () => void;
  sessions: {
    list(): AutopilotSessionInfo[];
    subscribe(listener: () => void): () => void;
  };
  /** How Autopilot's chat tab launches (the person's installed claude, bypassing permission prompts like a Session orchestrator). */
  launch: () => ChatTabLaunch;
  /** The skill's path, for the run's AGENTS.md. */
  skillPath: string;
  /** Calls `onChange` when `file` changes on disk, until the returned stop is called (tests call it themselves). */
  watchFile?: (file: string, onChange: () => void) => () => void;
  now?: () => number;
}

const NOT_STARTED = { message: 'Autopilot is not running.', next: 'Press Start in Autopilot.' };
const TURNED_OFF = { message: 'Autopilot is off.', next: 'Turn it on in Settings › Advanced › Experimental, then press Start.' };

/** Lines Autopilot's chat tab gets from Pane (Start, Pause, Go on), marked so it knows they come from the controls. */
const START_MESSAGE = '[Pane · Start] The person pressed Start. Follow the Start steps of the pane-autopilot skill: analyze everything first (every Session, its Panes, workers and PRs, and every waiting item on every machine), plan the order (unblock running work first, then keep active work moving, then propose closing what is stale), group it into a few workstreams with their approvals together, then drive: end every turn with your next step and never wait for the person to tell you what to do.';
const PAUSE_MESSAGE = '[Pane · Pause] The person paused you. Bring nothing new to the stack until they press Go on. You can still answer their questions.';
/** Sentinel Mode's defaults (D-93, the planner's, approved with r4). */
const SENTINEL_CHECK_MS = 5 * 60_000;
/** D-146: Autopilot drives the conversation. Idle this long while running, Pane wakes it to carry on. */
const DRIVE_IDLE_MS = 3 * 60_000;
/** Wake-ups in a row with no turn the person (or an event) started; then it waits for one. */
const DRIVE_MAX_IN_A_ROW = 3;
const CARRY_ON_MESSAGE = '[Pane · Carry on] You have been idle for 3 minutes and the person has not answered. Do not wait for them: take the next step that does not need them (check what changed, prepare the next workstream, write up a close-out), then end with your next step. If nothing at all can move without them, say so in one line and name what you will check next.';
const SENTINEL_ON_MESSAGE = '[Pane · Sentinel on] The person turned on Sentinel Mode and may be away. Follow the Sentinel section of the pane-autopilot skill: keep Sessions moving, answer only what a plan, a decision or a clear recommendation settles, nudge stuck Sessions (at most 2 per Session per hour), send everything else to the person as your own approval, and log every call in docs/away-log.html.';
const SENTINEL_CHECK_MESSAGE = '[Pane · Sentinel check] Five minutes since the last check: check in on every Session now, as the Sentinel section says.';
const BACK_MESSAGE = '[Pane · Back] The person opened Autopilot while Sentinel stays on, and your away log has calls they have not seen. Post the While you were away card for the calls since you last showed one (an autopilot-away block), then carry on. Sentinel stays on.';
const SENTINEL_OFF_MESSAGE = '[Pane · Sentinel off] The person turned Sentinel off and is back: post the While you were away card now (an autopilot-away block), then carry on as usual.';
const RESTART_QUESTION = { title: 'Sentinel stopped: Pane restarted', on: 'Turn Sentinel back on', off: 'Leave it off' };
const EXITED_QUESTION = { title: 'Autopilot stopped: its agent exited', on: 'Start again with Sentinel', off: 'Leave it stopped' };
/** The person's own instructions (D-196): longer than this is not a brief any more. */
const INSTRUCTIONS_LIMIT = 20_000;
const INSTRUCTIONS_FILE = 'instructions.md';
const instructionsMessage = (text: string) => (text
  ? `[Pane · Instructions] The person changed their own instructions for you. From now on, follow these instead of any earlier ones. ${OWN_INSTRUCTIONS_LABEL}\n\n${text}`
  : '[Pane · Instructions] The person cleared their own instructions for you: drop any earlier ones and follow Pane\'s built-in instructions only.');
const startMessage = (text: string) => (text ? `${START_MESSAGE}\n\n${OWN_INSTRUCTIONS_LABEL}\n\n${text}` : START_MESSAGE);
const GO_ON_MESSAGE = '[Pane · Go on] The person pressed Go on. Pick the walk up where you left it: check what waits now, then carry on from the top.';

/**
 * Autopilot (D-43, D-69): its switch, its runs in <PANE_DIR>/autopilot/, its agent (a chat tab
 * in a hidden owner Pane), its stack and walk, and the rule that it never answers (D-66).
 * Events: `changed` with the new snapshot after any change.
 */
export class AutopilotManager extends EventEmitter {
  private readonly store: AutopilotStore;
  private run: AutopilotRunInfo | null = null;
  private stack: AutopilotStack = { entries: [], shownId: null };
  /** Runtime state: every Pane start shows Start (J2), whatever the last run state was. */
  private state: AutopilotAgentState = 'stopped';
  private walkSessionId: string | undefined;
  private sentinel = false;
  private sentinelSince: number | undefined;
  private stopSentinelTimer: (() => void) | undefined;
  /** Sentinel was on when Pane last stopped: initialize() tells the person (D-57). */
  private sentinelWasOn = false;
  /** D-146: the pending carry-on wake-up, and how many Pane sent in a row. */
  private cancelDrive: (() => void) | undefined;
  private carryOnsInARow = 0;
  private carryOnSent = false;
  /** The away log as the person last saw it (when Sentinel went on, or its last card was asked for): its mtime and size. */
  private seenAwayLog: string | undefined;
  /** The person's instructions as the running agent has them (D-196); undefined while it is stopped. */
  private instructionsApplied: string | undefined;
  private stopWatchingInstructions: (() => void) | undefined;
  /** Pane is stopping the agent itself (off, a new run): the tab stopping then is expected. */
  private stoppingAgent = false;
  /** A Start in flight: a second press (the Sentinel switch, the phone) joins it instead of sending Start twice. */
  private starting: Promise<AutopilotSnapshot> | undefined;
  /** The open "start again?" card: withdrawn once the person starts Autopilot themselves. */
  private startAgainCard: AbortController | undefined;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly now: () => number;
  private emitScheduled = false;

  constructor(private readonly ports: AutopilotPorts) {
    super();
    this.setMaxListeners(50);
    this.store = new AutopilotStore(ports.root);
    this.now = ports.now ?? Date.now;
    this.run = this.store.current();
    if (this.run) {
      this.stack = this.store.readStack(this.run.id);
      const saved = this.store.readState(this.run.id);
      this.walkSessionId = saved.walkSessionId;
      this.sentinelWasOn = saved.sentinel === true;
    }
    this.unsubscribe.push(ports.notify.subscribe(() => this.onNotifyChanged()));
    this.unsubscribe.push(ports.sessions.subscribe(() => this.changed()));
    const offChat = ports.chat.subscribe?.(panelId => this.onChatChanged(panelId));
    if (offChat) this.unsubscribe.push(offChat);
  }

  /**
   * Its agent can exit on its own (a crash, the CLI quitting). Autopilot then stops too, so the
   * sidebar, status and Sentinel never claim work that is not happening; Start brings it back.
   */
  private onChatChanged(panelId: string): void {
    if (!this.run || panelId !== panelIdOf(this.run.id) || this.stoppingAgent) return;
    if (this.state === 'stopped') return;
    if (this.ports.chat.isRunning(panelId)) {
      this.drive(panelId);
      return;
    }
    const sentinelWasOn = this.sentinel;
    this.log(`the agent stopped on its own; Autopilot stopped${sentinelWasOn ? ' and Sentinel is off' : ''}`);
    this.setState('stopped');
    // The person is away while Sentinel runs: they hear it on their phone and can start it again from there.
    if (sentinelWasOn && this.ports.config.autopilotEnabled()) void this.askToStartAgain(EXITED_QUESTION, 'Autopilot\'s agent exited, so Sentinel stopped keeping your Sessions moving. Its chat shows what happened.');
  }

  dispose(): void {
    this.stopDriving();
    this.stopWatchingInstructions?.();
    this.stopWatchingInstructions = undefined;
    this.stopSentinelTimer?.();
    this.stopSentinelTimer = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
    this.removeAllListeners();
  }

  /** At Pane start: the current run's tab exists, stopped, so the view shows Start (J2). */
  async initialize(): Promise<void> {
    if (!this.run) return;
    const panelId = panelIdOf(this.run.id);
    // A tab saved idle or working would start its agent as soon as it is opened; it waits for Start instead.
    if (this.ports.chat.exists(panelId)) {
      await this.ports.chat.stop(panelId, NOT_STARTED.message, NOT_STARTED.next);
      // Pane's own lines from before the restart (Sentinel on, a check) no longer hold; the person's messages stay queued.
      const dropped = this.ports.chat.unqueueWhere(panelId, text => text.trimStart().startsWith('[Pane · '));
      if (dropped > 0) this.log(`dropped ${dropped} control line(s) queued before the restart`);
      // Its conversation comes back with the agent's session, so the chat isn't empty until Start.
      if (this.ports.config.autopilotEnabled()) await this.ports.chat.resume(panelId).catch(error => this.log(`could not reload the conversation: ${String(error)}`));
    }
    if (this.ports.config.autopilotEnabled()) await this.ensureAgentTab(this.run);
    if (this.sentinelWasOn) {
      // Nothing runs before Start (D-57): Sentinel is off again, and the person hears it on their phone.
      this.sentinelWasOn = false;
      this.store.writeState(this.run.id, { state: 'stopped', walkSessionId: this.walkSessionId });
      this.log('Sentinel stopped: Pane restarted');
      if (this.ports.config.autopilotEnabled()) void this.askToStartAgain(RESTART_QUESTION, 'Sentinel Mode was keeping your Sessions moving. Pane restarted, so it stopped, and Autopilot waits for Start.');
    }
  }

  /**
   * D-146: while Autopilot runs it never waits for the person to say what's next. When its agent
   * goes idle, Pane wakes it after a few minutes to carry on with what doesn't need them; after a
   * few wake-ups in a row it waits for the person or an event. Paused, Sentinel (its own checks)
   * and stopped don't drive.
   */
  private drive(panelId: string): void {
    this.stopDriving();
    if (this.state !== 'running' || this.sentinel) return;
    if (this.ports.chat.isBusy(panelId)) {
      // A turn Pane didn't start (the person, or an event its watch caught) starts the count over.
      if (!this.carryOnSent) this.carryOnsInARow = 0;
      this.carryOnSent = false;
      return;
    }
    if (this.carryOnsInARow >= DRIVE_MAX_IN_A_ROW) return;
    const after = this.ports.after ?? defaultAfter;
    this.cancelDrive = after(DRIVE_IDLE_MS, () => {
      this.cancelDrive = undefined;
      if (this.state !== 'running' || this.sentinel || this.ports.chat.isBusy(panelId)) return;
      this.carryOnsInARow += 1;
      this.carryOnSent = true;
      this.trySend(panelId, CARRY_ON_MESSAGE);
      this.log(`carry on (${this.carryOnsInARow} in a row)`);
    });
  }

  private stopDriving(): void {
    this.cancelDrive?.();
    this.cancelDrive = undefined;
  }

  /** Asks the person (it reaches their phone) whether to turn Sentinel back on; yes also starts Autopilot. */
  private async askToStartAgain(question: { title: string; on: string; off: string }, context: string): Promise<void> {
    this.startAgainCard?.abort();
    const card = new AbortController();
    this.startAgainCard = card;
    try {
      const result = await this.ports.notify.ask({
        ui: 'options',
        title: question.title,
        context,
        choices: [{ label: question.on, recommended: true }, { label: question.off }],
      }, card.signal);
      if (this.startAgainCard === card) this.startAgainCard = undefined;
      if ('answer' in result && result.answer === question.on) await this.setSentinel(true).catch((error: Error) => this.tellCouldNotStart(error.message, error instanceof PaneError ? error.next : undefined));
    } catch (error) {
      this.log(`could not ask about Sentinel (${question.title}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The person said yes from their phone, and Start failed: they hear why, where they answered. */
  private async tellCouldNotStart(message: string, next: string | undefined): Promise<void> {
    this.log(`could not turn Sentinel back on: ${message}`);
    await this.ports.notify.ask({ ui: 'info', title: 'Sentinel did not start', context: [message, next].filter(Boolean).join(' ') })
      .catch(() => { /* Logged above; Autopilot's view shows Start. */ });
  }

  snapshot(): AutopilotSnapshot {
    const run = this.run;
    const snapshot: AutopilotSnapshot = {
      enabled: this.ports.config.autopilotEnabled(),
      chatTabsEnabled: this.ports.config.chatTabsEnabled(),
      entitlement: autopilotEntitlement(),
      run: run ? { ...run } : null,
      panelId: run ? panelIdOf(run.id) : null,
      ownerPaneId: run ? ownerPaneIdOf(run.id) : null,
      state: this.state,
      sentinel: this.sentinel,
      stack: structuredClone(this.stack),
      walk: this.walk(),
    };
    if (this.sentinelSince !== undefined) snapshot.sentinelSince = this.sentinelSince;
    const named = new Set(this.stack.entries.flatMap(entry => entry.ref.kind === 'item' ? [entry.ref.notifyId] : []));
    const elsewhere = named.size > 0 ? this.ports.notify.items().filter(item => named.has(item.id) && (item.machineId ?? 'local') !== 'local') : [];
    if (elsewhere.length > 0) snapshot.otherMachineItems = elsewhere;
    return snapshot;
  }

  // ---- The switch and runs (package 1) ----

  /** Settings › Advanced › Experimental › Autopilot. Off stops the agent and keeps the run. */
  async setEnabled(enabled: boolean): Promise<AutopilotSnapshot> {
    if (enabled) {
      assertAutopilotEntitled('Turning Autopilot on');
      this.requireChatTabs('Turning Autopilot on');
      await this.ports.config.setAutopilotEnabled(true);
      const run = this.run ?? this.createRun();
      await this.ensureAgentTab(run);
      this.log('turned on');
    } else {
      await this.ports.config.setAutopilotEnabled(false);
      if (this.run) {
        this.endSentinel();
        await this.stopAgent(TURNED_OFF);
        this.log('turned off; the run is kept');
      }
    }
    this.changed();
    return this.snapshot();
  }

  /** Start (D-57): the agent runs and walks the Sessions. Opening Autopilot never does this. */
  async start(): Promise<AutopilotSnapshot> {
    this.requireOn('Start');
    assertAutopilotEntitled('Start');
    this.requireChatTabs('Start');
    if (this.state !== 'stopped') return this.snapshot();
    this.startAgainCard?.abort();
    this.startAgainCard = undefined;
    this.starting ??= this.startAgent().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startAgent(): Promise<AutopilotSnapshot> {
    const run = this.run ?? this.createRun();
    await this.ensureAgentTab(run);
    const panelId = panelIdOf(run.id);
    await this.ports.chat.ensure(panelId);
    const own = this.readInstructions();
    this.writeAgentsFile(run, own);
    this.ports.chat.send(panelId, startMessage(own));
    this.instructionsApplied = own;
    this.setState('running');
    this.log('started');
    return this.snapshot();
  }

  pause(): AutopilotSnapshot {
    this.requireRunning('Pause');
    if (this.state === 'paused') return this.snapshot();
    this.setState('paused');
    if (this.run) this.trySend(panelIdOf(this.run.id), PAUSE_MESSAGE);
    this.log('paused');
    return this.snapshot();
  }

  goOn(): AutopilotSnapshot {
    this.requireRunning('Go on');
    if (this.state === 'running') return this.snapshot();
    this.setState('running');
    if (this.run) this.trySend(panelIdOf(this.run.id), GO_ON_MESSAGE);
    this.log('going on');
    return this.snapshot();
  }

  /** "New Autopilot Session" (D-67): a new run folder and conversation; the old run's documents stay. */
  async newRun(): Promise<AutopilotSnapshot> {
    this.requireOn('New Autopilot Session');
    assertAutopilotEntitled('New Autopilot Session');
    if (this.run) {
      this.endSentinel();
      await this.stopAgent({ message: 'This Autopilot Session ended: a new one started.', next: 'Its documents stay in its folder.' });
      this.log('a new Autopilot Session replaced this one');
    }
    const run = this.createRun();
    await this.ensureAgentTab(run);
    this.changed();
    return this.snapshot();
  }

  // ---- The person's own instructions (D-196) ----

  /** What Settings › Autopilot shows: the person's text, its file, Pane's built-in instructions, and whether the agent has them. */
  instructions(): AutopilotInstructionsView {
    const text = this.readInstructions();
    const status = !text && !this.instructionsApplied ? 'none' : this.instructionsApplied === text ? (text ? 'applied' : 'none') : 'next-start';
    return { text, path: this.instructionsFile(), builtIn: this.builtInInstructions(), status };
  }

  /** Saves the person's instructions (Reset saves ''); a running agent gets them at once, a stopped one at the next Start. */
  async setInstructions(text: string): Promise<AutopilotInstructionsView> {
    const trimmed = text.trim();
    if (trimmed.length > INSTRUCTIONS_LIMIT) {
      throw new PaneError('AUTOPILOT_INSTRUCTIONS_TOO_LONG', `Your instructions are ${trimmed.length.toLocaleString('en-US')} characters, over the ${INSTRUCTIONS_LIMIT.toLocaleString('en-US')} Autopilot reads. Nothing was saved.`, 'Shorten them: a few lines on how you want Autopilot to work is enough.');
    }
    const file = this.instructionsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, trimmed ? `${trimmed}\n` : '', { mode: 0o600 });
    fs.renameSync(temp, file);
    this.deliverInstructions();
    return this.instructions();
  }

  private instructionsFile(): string {
    return path.join(this.ports.root, INSTRUCTIONS_FILE);
  }

  private readInstructions(): string {
    try { return fs.readFileSync(this.instructionsFile(), 'utf8').trim().slice(0, INSTRUCTIONS_LIMIT); } catch { return ''; }
  }

  /** The running agent gets the person's instructions as they are on disk, once per change. */
  private deliverInstructions(): void {
    if (!this.run || this.state === 'stopped' || this.instructionsApplied === undefined) return;
    const text = this.readInstructions();
    if (text === this.instructionsApplied) return;
    this.writeAgentsFile(this.run, text);
    this.trySend(panelIdOf(this.run.id), instructionsMessage(text));
    this.instructionsApplied = text;
    this.log(text ? 'the person\'s instructions changed; sent to the agent' : 'the person cleared their instructions; told the agent');
    this.changed();
  }

  private writeAgentsFile(run: AutopilotRunInfo, own: string): void {
    fs.writeFileSync(path.join(run.folder, 'AGENTS.md'), autopilotInstructions(run, this.ports.skillPath, { text: own, file: this.instructionsFile() }), { mode: 0o600 });
  }

  private builtInInstructions(): string {
    const run = this.run ?? { id: '<run>', folder: '<run folder>', docsFolder: '<run folder>/docs', createdAt: '' };
    let skill: string;
    try { skill = fs.readFileSync(this.ports.skillPath, 'utf8'); } catch { skill = `(The skill is not installed yet: ${this.ports.skillPath}.)`; }
    return `${autopilotInstructions(run, this.ports.skillPath)}\n# What Start tells it\n\n${START_MESSAGE}\n\n# The pane-autopilot skill (${this.ports.skillPath})\n\n${skill}`;
  }

  // ---- Sentinel Mode (package 7) ----

  /** The toggle in Autopilot's header. On also starts Autopilot; off asks for the While you were away card. */
  async setSentinel(on: boolean): Promise<AutopilotSnapshot> {
    this.requireOn('Sentinel');
    if (on === this.sentinel) return this.snapshot();
    if (on) {
      if (this.state === 'stopped') await this.start();
      // Another press turned it on while Start ran.
      if (this.sentinel) return this.snapshot();
      // From Pause, the Sentinel line itself says to carry on; a Go on line too would queue a second turn.
      else if (this.state === 'paused') this.setState('running');
      const run = this.requireRun();
      this.stopDriving();
      this.sentinel = true;
      this.sentinelSince = this.now();
      this.seenAwayLog = this.awayLogStamp();
      this.trySend(panelIdOf(run.id), SENTINEL_ON_MESSAGE);
      const every = this.ports.every ?? defaultEvery;
      this.stopSentinelTimer = every(SENTINEL_CHECK_MS, () => this.sentinelCheck());
      this.log('Sentinel on');
    } else {
      this.endSentinel();
      if (this.run && this.state !== 'stopped') this.trySend(panelIdOf(this.run.id), SENTINEL_OFF_MESSAGE);
      this.log('Sentinel off');
    }
    this.saveState();
    this.changed();
    return this.snapshot();
  }

  /**
   * The person opened Autopilot (desktop view or phone screen). With Sentinel on, every call it
   * makes goes in docs/away-log.html; if that log changed since the person last saw it, they get the
   * While you were away card for those calls, however short the time away (J29). Nothing new, or a
   * stopped or Sentinel-off run, sends nothing.
   */
  opened(): void {
    if (!this.sentinel || this.state !== 'running' || !this.run) return;
    const stamp = this.awayLogStamp();
    if (stamp === this.seenAwayLog) return;
    this.seenAwayLog = stamp;
    this.trySend(panelIdOf(this.run.id), BACK_MESSAGE);
    this.log('the person is back (opened Autopilot with Sentinel calls they have not seen)');
  }

  /** The run's away log's mtime and size, or undefined while there is none. */
  private awayLogStamp(): string | undefined {
    if (!this.run) return undefined;
    try {
      const stat = fs.statSync(path.join(this.run.docsFolder, 'away-log.html'));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  }

  /** Wakes the agent to check in, unless it is mid-turn (the next tick catches up) or paused. */
  private sentinelCheck(): void {
    if (!this.sentinel || !this.run || this.state !== 'running') return;
    const panelId = panelIdOf(this.run.id);
    if (this.ports.chat.isBusy(panelId)) return;
    this.trySend(panelId, SENTINEL_CHECK_MESSAGE);
  }

  private endSentinel(): void {
    this.stopSentinelTimer?.();
    this.stopSentinelTimer = undefined;
    this.sentinel = false;
    this.sentinelSince = undefined;
    this.seenAwayLog = undefined;
  }

  // ---- The stack (package 2d) ----

  pushToStack(request: AutopilotStackPushRequest, caller?: AutopilotCaller): AutopilotSnapshot {
    return this.push(request, caller).snapshot;
  }

  /** Puts something on the stack and says which entry that made or refreshed: its receipt for the CLI and MCP. */
  push(request: AutopilotStackPushRequest, caller?: AutopilotCaller): AutopilotStackPushOutcome {
    this.requireOn('Putting it on the stack');
    if (this.state === 'paused' && this.isAutopilotCaller(caller)) {
      throw new PaneError('AUTOPILOT_PAUSED', 'The person paused Autopilot, so nothing new goes on the stack. Nothing was added.', 'Wait for [Pane · Go on] before bringing anything new; you can still answer the person in the chat.');
    }
    const run = this.requireRun();
    const entry = this.entryFor(request);
    this.stack = pushEntry(this.stack, entry, request.next ? 'next' : 'end');
    if (entry.sessionId) this.walkSessionId = entry.sessionId;
    this.saveStack(run);
    this.log(`stack push: ${entry.title}`);
    this.changed();
    // An entry already on the stack for the same target is refreshed in place and keeps its id.
    const pushed = this.stack.entries.find(candidate => sameRef(candidate.ref, entry.ref)) ?? entry;
    return { snapshot: this.snapshot(), entry: pushed };
  }

  /** ‹ › / ← →, a chip, or dismissing the shown entry. */
  moveStack(command: { type: 'step'; direction: 1 | -1 } | { type: 'show'; id: string } | { type: 'dismiss'; id: string }): AutopilotSnapshot {
    const run = this.requireRun();
    if (command.type === 'step') this.stack = stepStack(this.stack, command.direction);
    else if (command.type === 'show') this.stack = showEntry(this.stack, command.id);
    else this.stack = resolveEntries(this.stack, new Set([command.id]), this.now());
    this.saveStack(run);
    this.changed();
    return this.snapshot();
  }

  // ---- What waits (package 2a) ----

  /** Every item waiting on the person, this machine's Sessions first in sidebar order, then the rest. */
  waiting(): AutopilotWaitingItem[] {
    const now = this.now();
    const order = new Map(this.ports.sessions.list().filter(session => !session.archived).map((session, index) => [session.id, index]));
    const onStack = new Set(this.stack.entries.flatMap(entry => entry.ref.kind === 'item' && entry.doneAt === undefined ? [entry.ref.notifyId] : []));
    return this.ports.notify.items()
      .filter(item => item.state === 'waiting')
      .map(item => waitingItem(item, now, onStack.has(item.id), this.isAutopilotItem(item)))
      .sort((a, b) => rank(a, order) - rank(b, order) || a.createdAt - b.createdAt);
  }

  // ---- Authority (D-66) ----

  /** The call came from the current run's agent (its tab, or its owner Pane). */
  isAutopilotCaller(caller: AutopilotCaller | undefined): boolean {
    if (!caller) return false;
    if (caller.panelId?.startsWith(AUTOPILOT_PANEL_PREFIX)) return true;
    return !!caller.paneId?.startsWith(AUTOPILOT_OWNER_PANE_PREFIX);
  }

  /** Approvals are always the person's: any answer from Autopilot is refused, on every route. */
  refuseAnswerFrom(caller: AutopilotCaller | undefined, what: string): void {
    if (!this.isAutopilotCaller(caller)) return;
    this.log(`refused: ${what}`);
    throw new PaneError(
      'AUTOPILOT_CANNOT_ANSWER',
      `Autopilot cannot answer ${what}: permission prompts and raw keys into other tabs stay the person's, and its answers are recorded as its own (D-149). Nothing was answered; it still waits.`,
      'For an approval or question, use runpane autopilot answer or close. For a permission prompt, point the person to the buttons on the card in the stack (or "Open in Pane").',
    );
  }

  private isAutopilotItem(item: NotifyItem): boolean {
    return this.isAutopilotCaller({ paneId: item.source.paneId, panelId: item.source.panelId });
  }

  // ---- Internals ----

  private onNotifyChanged(): void {
    if (!this.run) return;
    const open = new Map(this.ports.notify.items().map(item => [item.id, item]));
    const resolved = new Set(this.stack.entries.flatMap(entry => {
      if (entry.doneAt !== undefined || entry.ref.kind !== 'item') return [];
      const item = open.get(entry.ref.notifyId);
      // Gone from the snapshot, answered, or expired: the person is done with it. A held answer (`sent`) stays until Undo passes.
      if (!item) return this.ports.notify.notReadYet(entry.ref.notifyId) ? [] : [entry.id];
      return item.state === 'answered' || item.state === 'expired' ? [entry.id] : [];
    }));
    if (resolved.size > 0) {
      this.stack = resolveEntries(this.stack, resolved, this.now());
      this.saveStack(this.run);
    }
    this.changed();
  }

  private entryFor(request: AutopilotStackPushRequest): AutopilotStackEntry {
    const targets = [request.item, request.file, request.url, request.session].filter(value => value !== undefined && value !== '');
    if (targets.length !== 1) {
      throw new PaneError('AUTOPILOT_STACK_INVALID', 'A stack entry needs exactly one of --item, --file, --url or --session. Nothing was added.', 'Run runpane autopilot stack push --item <id> (or --file, --url, --session) with one target.');
    }
    const extraTabs = (request.tabs ?? []).map(tab => this.tabFor(tab));
    const id = randomUUID();
    const addedAt = this.now();
    if (request.item) {
      const item = this.ports.notify.items().find(candidate => candidate.id === request.item);
      if (!item) throw new PaneError('AUTOPILOT_STACK_INVALID', `No waiting item has the id ${request.item}. Nothing was added.`, 'List what waits with runpane autopilot waiting --json and use an id from it.');
      const label = item.agentPrompt ? 'Permission' : item.ui === 'approve' ? 'Approval' : 'Question';
      const linkTabs: AutopilotTab[] = (item.links ?? []).map(link => 'path' in link ? { kind: 'file', label: link.label, path: link.path } : 'approval' in link ? { kind: 'item', label: link.label, notifyId: link.approval } : { kind: 'url', label: link.label, url: link.url });
      return {
        id, addedAt,
        ref: { kind: 'item', notifyId: item.id },
        title: request.title?.trim() || item.title,
        note: request.note,
        sessionId: item.source.session?.id,
        sessionName: item.source.session?.name,
        tabs: dedupeTabs([{ kind: 'item', label, notifyId: item.id }, ...linkTabs, ...extraTabs]),
        byAutopilot: this.isAutopilotItem(item) || undefined,
      };
    }
    if (request.session) {
      const session = this.ports.sessions.list().find(candidate => candidate.id === request.session || candidate.name === request.session);
      if (!session) throw new PaneError('AUTOPILOT_STACK_INVALID', `No Session is called or has the id ${request.session}. Nothing was added.`, 'List Sessions with runpane sessions list --json.');
      return { id, addedAt, ref: { kind: 'session', sessionId: session.id }, title: request.title?.trim() || `${session.name}: what's left`, note: request.note, sessionId: session.id, sessionName: session.name, tabs: dedupeTabs([{ kind: 'session', label: 'Overview', sessionId: session.id }, ...extraTabs]) };
    }
    const main = this.tabFor(request.file !== undefined ? { path: request.file } : { url: request.url });
    const ref = main.kind === 'file' ? { kind: 'file' as const, path: main.path } : { kind: 'url' as const, url: main.kind === 'url' ? main.url : '' };
    const run = this.run;
    const byAutopilot = main.kind === 'file' && !!run && isInside(run.folder, main.path);
    return { id, addedAt, ref, title: request.title?.trim() || main.label, note: request.note, tabs: dedupeTabs([main, ...extraTabs]), byAutopilot: byAutopilot || undefined };
  }

  private tabFor(tab: { label?: string; path?: string; url?: string }): AutopilotTab {
    if (tab.path) {
      const resolved = path.resolve(this.run?.folder ?? process.cwd(), tab.path);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new PaneError('AUTOPILOT_STACK_INVALID', `There is no file at ${resolved}. Nothing was added.`, 'Write the document first (in your run\'s docs/ folder), then put it on the stack.');
      }
      return { kind: 'file', label: tab.label?.trim() || path.basename(resolved), path: resolved };
    }
    if (tab.url) {
      let parsed: URL;
      try { parsed = new URL(tab.url); } catch { throw new PaneError('AUTOPILOT_STACK_INVALID', `${tab.url} is not a URL. Nothing was added.`, 'Pass a full http(s) URL.'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new PaneError('AUTOPILOT_STACK_INVALID', `Only http and https URLs open in the App tab (got ${parsed.protocol}). Nothing was added.`, 'Pass a file with --file instead.');
      return { kind: 'url', label: tab.label?.trim() || parsed.host, url: parsed.toString() };
    }
    throw new PaneError('AUTOPILOT_STACK_INVALID', 'A tab needs a file path or a URL. Nothing was added.', 'Pass --tab <path-or-url>.');
  }

  private walk(): AutopilotWalk {
    const counts = new Map<string, number>();
    for (const item of this.ports.notify.items()) {
      const id = item.state === 'waiting' && (item.machineId ?? 'local') === 'local' ? item.source.session?.id : undefined;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const sessions = this.ports.sessions.list().filter(session => !session.archived).map(session => ({ id: session.id, name: session.name, waiting: counts.get(session.id) ?? 0 }));
    const shown = shownEntry(this.stack);
    const sessionId = shown?.doneAt === undefined && shown?.sessionId ? shown.sessionId : this.walkSessionId;
    return { sessionId: sessions.some(session => session.id === sessionId) ? sessionId : undefined, sessions };
  }

  private createRun(): AutopilotRunInfo {
    const run = this.store.createRun(new Date(this.now()));
    this.run = run;
    this.stack = { entries: [], shownId: null };
    this.walkSessionId = undefined;
    this.state = 'stopped';
    this.writeAgentsFile(run, this.readInstructions());
    fs.writeFileSync(path.join(run.folder, 'CLAUDE.md'), '@AGENTS.md\n', { mode: 0o600 });
    return run;
  }

  /** The run's hidden owner Pane and its chat tab, created stopped: no agent process until Start (J2). */
  private async ensureAgentTab(run: AutopilotRunInfo): Promise<void> {
    const ownerPaneId = ownerPaneIdOf(run.id);
    if (!this.ports.owner.exists(ownerPaneId)) this.ports.owner.create(ownerPaneId, 'Autopilot', run.folder);
    const panelId = panelIdOf(run.id);
    if (this.ports.chat.exists(panelId)) return;
    const state: ChatPanelState = {
      agent: DEFAULT_AGENT_ID,
      launch: this.ports.launch(),
      cwd: run.folder,
      status: 'stopped',
      problem: { code: 'exited', message: NOT_STARTED.message, next: NOT_STARTED.next },
      autopilotRunId: run.id,
    };
    await this.ports.chat.create(panelId, ownerPaneId, 'Autopilot', state);
  }

  private async stopAgent(reason: { message: string; next: string }): Promise<void> {
    if (!this.run) return;
    const panelId = panelIdOf(this.run.id);
    this.stoppingAgent = true;
    try {
      if (this.ports.chat.exists(panelId)) await this.ports.chat.stop(panelId, reason.message, reason.next);
    } finally { this.stoppingAgent = false; }
    this.setState('stopped');
  }

  private trySend(panelId: string, text: string): void {
    try { this.ports.chat.send(panelId, text); } catch (error) { this.log(`could not tell the agent: ${error instanceof Error ? error.message : String(error)}`); }
  }

  private setState(state: AutopilotAgentState): void {
    this.state = state;
    if (state === 'stopped') {
      this.instructionsApplied = undefined;
      this.stopWatchingInstructions?.();
      this.stopWatchingInstructions = undefined;
    } else if (!this.stopWatchingInstructions) {
      // An edit to the file itself (an editor, the CLI, Autopilot after the person approved a line) reaches the agent too.
      const watch = this.ports.watchFile ?? defaultWatchFile;
      this.stopWatchingInstructions = watch(this.instructionsFile(), () => this.deliverInstructions());
    }
    if (state !== 'running') this.stopDriving();
    if (state === 'stopped') this.carryOnsInARow = 0;
    if (state === 'stopped') this.endSentinel();
    this.saveState();
    this.changed();
  }

  private saveState(): void {
    if (!this.run) return;
    const saved: AutopilotRunState = { state: this.state, walkSessionId: this.walkSessionId };
    if (this.sentinel) saved.sentinel = true;
    this.store.writeState(this.run.id, saved);
  }

  private saveStack(run: AutopilotRunInfo): void {
    this.store.writeStack(run.id, this.stack);
    this.saveState();
  }

  private log(line: string): void {
    if (this.run) this.store.log(this.run.id, line, new Date(this.now()));
  }

  private requireOn(action: string): void {
    if (this.ports.config.autopilotEnabled()) return;
    throw new PaneError('AUTOPILOT_OFF', `Autopilot is off, so ${lower(action)} was not done.`, 'Turn it on in Settings › Advanced › Experimental › Autopilot.');
  }

  private requireChatTabs(action: string): void {
    if (this.ports.config.chatTabsEnabled()) return;
    throw new PaneError('AUTOPILOT_NEEDS_CHAT_TABS', `Autopilot runs as a chat tab, and chat tabs are off. ${action} was not done.`, 'Turn on Chat tabs in Settings › AI & Agents, then try again.');
  }

  private requireRun(): AutopilotRunInfo {
    this.requireOn('That');
    if (!this.run) throw new PaneError('AUTOPILOT_NOT_STARTED', 'Autopilot has no run yet. Nothing changed.', 'Press Start in Autopilot.');
    return this.run;
  }

  private requireRunning(action: string): void {
    this.requireOn(action);
    if (this.state === 'stopped') throw new PaneError('AUTOPILOT_NOT_STARTED', `Autopilot is not running, so ${action} did nothing.`, 'Press Start in Autopilot.');
  }

  private changed(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      this.emit('changed', this.snapshot());
    });
  }
}

function defaultAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function defaultEvery(ms: number, run: () => void): () => void {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

function ownerPaneIdOf(runId: string): string { return `${AUTOPILOT_OWNER_PANE_PREFIX}${runId}`; }
function panelIdOf(runId: string): string { return `${AUTOPILOT_PANEL_PREFIX}${runId}`; }

function lower(text: string): string { return text.charAt(0).toLowerCase() + text.slice(1); }

function isInside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function dedupeTabs(tabs: AutopilotTab[]): AutopilotTab[] {
  const seen = new Set<string>();
  return tabs.filter(tab => {
    const key = tab.kind === 'file' ? `f:${tab.path}` : tab.kind === 'url' ? `u:${tab.url}` : tab.kind === 'item' ? `i:${tab.notifyId}` : `s:${tab.sessionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rank(item: AutopilotWaitingItem, order: Map<string, number>): number {
  if (item.machineId !== 'local') return Number.MAX_SAFE_INTEGER;
  if (item.byAutopilot) return Number.MAX_SAFE_INTEGER - 2;
  return item.sessionId !== undefined && order.has(item.sessionId) ? order.get(item.sessionId) ?? 0 : Number.MAX_SAFE_INTEGER - 1;
}

function waitingItem(item: NotifyItem, now: number, onStack: boolean, byAutopilot: boolean): AutopilotWaitingItem {
  const kind: AutopilotWaitingItem['kind'] = item.agentPrompt ? 'permission' : item.ui === 'approve' ? 'approval' : 'question';
  const result: AutopilotWaitingItem = {
    id: item.id,
    title: item.title,
    kind,
    agent: item.source.agent,
    pane: item.source.name,
    links: (item.links ?? []).flatMap((link): AutopilotWaitingItem['links'] => 'path' in link ? [{ label: link.label, path: link.path }] : 'url' in link ? [{ label: link.label, url: link.url }] : []),
    createdAt: item.createdAt,
    ageMs: Math.max(0, now - item.createdAt),
    machine: item.machine ?? 'this machine',
    machineId: item.machineId ?? 'local',
    onStack,
  };
  if (item.source.session) {
    result.sessionId = item.source.session.id;
    result.sessionName = item.source.session.name;
    if (item.source.session.orchestrator) result.orchestrator = true;
  }
  if (item.source.paneId) result.paneId = item.source.paneId;
  if (item.source.panelId) result.panelId = item.source.panelId;
  if (byAutopilot) result.byAutopilot = true;
  if (item.context) result.context = item.context;
  if (item.choices?.length) result.choices = item.choices.map(choice => choice.label);
  if (item.quiet) result.quiet = true;
  if (item.staleSince !== undefined) result.stale = true;
  if (item.connected) result.connected = item.connected;
  if (item.reopened) result.reopened = item.reopened;
  return result;
}

function defaultWatchFile(file: string, onChange: () => void): () => void {
  const listener = () => onChange();
  fs.watchFile(file, { interval: 1500, persistent: false }, listener);
  return () => fs.unwatchFile(file, listener);
}
