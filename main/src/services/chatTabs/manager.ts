import { createHash } from 'crypto';
import path from 'path';
import type { ContentBlock, McpServer, NewSessionRequest } from '@agentclientprotocol/sdk';
import type { AgentState, PanelAgentStatusEvent } from '../../../../shared/types/agentStatus';
import type { AgentChatMessage, AgentChatReceipt } from '../../../../shared/types/agentChat';
import type { ToolPanel } from '../../../../shared/types/panels';
import { CHAT_PROMPT_LIMIT, type ChatPanelState, type ChatTabEvent, type ChatTabAnswer, type ChatTabProblem, type ChatTabQueuedPrompt, type ChatTabSend, type ChatTabStatus, type ChatTabView } from '../../../../shared/types/chatTab';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { AgentCommand } from './agentProcess';
import { ChatTabRuntime, chatFailure, isAuthRequired, type RuntimeExit } from './runtime';
import { ChatTranscript } from './transcript';
import { QueuedBodies } from './queuedBodies';

/** Everything the agent process needs, rebuilt at every start. Never saved. */
export interface ResolvedLaunch {
  command: AgentCommand;
  /** `_meta` for session/new and session/load (Claude's `claudeCode.options`). */
  meta?: JsonObject;
  mcpServers?: McpServer[];
  /** Session settings to apply once, on a new conversation. */
  initialSettings?: Record<string, string>;
  /** The session mode to select after every session/new and session/load (an Agent Farm profile's permission mode). */
  mode?: string;
}

/** Events a chat tab sends to every viewer. */
type ChatTabChannel = 'chat-tab:event' | 'chat-tab:state' | 'panel:agentStatus';

export interface ChatTabLauncher {
  /** Throws a PaneError; `CHAT_NOT_SIGNED_IN`, `CHAT_AGENT_NOT_INSTALLED`, `CHAT_AGENT_OUTDATED`, `CHAT_ADAPTER_MISSING` and `CHAT_UNSUPPORTED_HOST` become their stopped states. */
  resolve(panel: ToolPanel, state: ChatPanelState): Promise<ResolvedLaunch>;
}

export interface ChatTabStore {
  panel(panelId: string): ToolPanel | undefined;
  state(panelId: string): ChatPanelState | undefined;
  /** Durable before it returns. */
  commit(panelId: string, state: ChatPanelState): void;
}

export interface ChatTabManagerOptions {
  store: ChatTabStore;
  launcher: ChatTabLauncher;
  send: (channel: ChatTabChannel, payload: ChatTabEvent | ChatTabView | PanelAgentStatusEvent) => void;
  spoolDirectory: string;
  onStatus?: (event: PanelAgentStatusEvent) => void;
  /** Every view the host publishes (approvals and questions for Notify). */
  onView?: (view: ChatTabView) => void;
  /** The tab was closed; nothing about it is published again (its Notify cards close). */
  onClosed?: (panelId: string) => void;
  windowMessages?: number;
  /** How long closing, stopping or quitting waits for a tab's agent to end. Default 5 s. */
  stopTimeoutMs?: number;
}

interface Tab {
  /** The public generation: viewers drop any state older than the newest they saw, so it only grows. */
  generation: number;
  /** The live runtime's generation; 0 once released, so late callbacks from a stopped runtime are ignored. */
  run: number;
  runtime?: ChatTabRuntime;
  transcript?: ChatTranscript;
  starting?: Promise<void>;
  loading: boolean;
  delivering: boolean;
  /** When the agent began a turn of its own. */
  ownTurnStartedAt?: string;
  notice?: string;
  published?: AgentState;
  launch?: ResolvedLaunch;
}

const DEFAULT_VIEW_LIMIT = 200;
const RECEIPT_LIMIT = 256;
/** Characters of a queued prompt kept in the tab's saved state for the queue list. */
const QUEUE_PREVIEW = 500;

/**
 * Host owner of every chat tab on this machine. Desktop, the remote PWA, the
 * phone and runpane all reach the same instance through chat-tab:* commands;
 * none of them can start a second runtime for a tab.
 */
export class ChatTabManager {
  private readonly tabs = new Map<string, Tab>();
  private lastGeneration = 0;
  private readonly bodies: QueuedBodies;

  constructor(private readonly options: ChatTabManagerOptions) {
    this.bodies = new QueuedBodies(panelId => path.join(options.spoolDirectory, safeName(panelId), 'queue'));
  }

  /** The tab's view. Opening a tab that is not running starts it, unless it stopped for a reason. */
  view(panelId: string, limit = DEFAULT_VIEW_LIMIT, start = true): ChatTabView {
    const state = this.required(panelId);
    const tab = this.tab(panelId);
    if (start && !tab.runtime && !tab.starting && state.status !== 'stopped') void this.ensure(panelId).catch(() => undefined);
    return this.snapshot(panelId, state, tab, limit);
  }

  history(panelId: string, before: number, limit: number): AgentChatMessage[] {
    this.required(panelId);
    return this.tab(panelId).transcript?.history(before, Math.min(500, limit)) ?? [];
  }

  /** The conversation's messages for readers such as runpane; pages through spooled history without copying it all at once. */
  messages(panelId: string): Iterable<AgentChatMessage> {
    this.required(panelId);
    return this.tab(panelId).transcript?.all() ?? [];
  }

  lastMessage(panelId: string, role: AgentChatMessage['role'] = 'assistant', accept: (message: AgentChatMessage) => boolean = () => true): AgentChatMessage | undefined {
    return this.tab(panelId).transcript?.last(role, accept);
  }

  /** The tab's status as agent status (sidebar, tabs, runpane), without starting it. */
  agentState(panelId: string): AgentState {
    const state = this.options.store.state(panelId);
    if (!state) return 'unknown';
    return toAgentState(this.snapshot(panelId, state, this.tab(panelId), 0));
  }

  isRunning(panelId: string): boolean { return !!this.tabs.get(panelId)?.runtime?.isAlive(); }
  runningPanelIds(): string[] { return [...this.tabs.entries()].flatMap(([panelId, tab]) => tab.runtime?.isAlive() ? [panelId] : []); }
  processId(panelId: string): number | undefined { return this.tabs.get(panelId)?.runtime?.pid; }
  /** Adapter process IDs of a Pane's running chat tabs, for archive cleanup. */
  sessionPids(sessionId: string): number[] {
    return [...this.tabs.entries()].flatMap(([panelId, tab]) => tab.runtime?.pid && this.options.store.panel(panelId)?.sessionId === sessionId ? [tab.runtime.pid] : []);
  }

  /** Starts the tab's agent once; concurrent callers share the same start. */
  ensure(panelId: string): Promise<void> {
    const tab = this.tab(panelId);
    if (tab.runtime?.isAlive()) return Promise.resolve();
    // Publish after the start settles: while it runs, every view says `starting`.
    tab.starting ??= this.start(panelId, tab).finally(() => {
      tab.starting = undefined;
      // A tab closed while it started is gone; nothing is published for it.
      if (this.tabs.get(panelId) !== tab) return;
      this.publish(panelId);
      this.drain(panelId);
    });
    return tab.starting;
  }

  async restart(panelId: string): Promise<void> {
    const tab = this.tab(panelId);
    await tab.starting?.catch(() => undefined);
    await this.release(tab);
    this.update(panelId, state => ({ ...state, status: 'starting', problem: undefined }));
    await this.ensure(panelId);
  }

  receipt(panelId: string, operationId: string): AgentChatReceipt | undefined {
    return structuredClone(this.required(panelId).receipts?.find(receipt => receipt.operationId === operationId));
  }

  /** Accepts a prompt. A prompt sent while the agent works is queued and delivered after the turn. */
  send(panelId: string, request: ChatTabSend): AgentChatReceipt {
    const state = this.required(panelId);
    const tab = this.tab(panelId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ text: request.text, images: request.images ?? [] })).digest('hex');
    const previous = state.receipts?.find(receipt => receipt.operationId === request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PaneError('CHAT_OPERATION_CONFLICT', 'This send was already used for a different message. Nothing new was sent.', 'Send the new message again; Pane gives it its own ID.');
      return structuredClone(previous);
    }
    if (!request.operationId || request.operationId.length > 128) throw new PaneError('CHAT_PROMPT_INVALID', 'The message has no valid send ID. Nothing was sent.', 'Send it again.');
    if (!request.text.trim() && !request.images?.length) throw new PaneError('CHAT_PROMPT_EMPTY', 'The message is empty. Nothing was sent.', 'Type a message or attach an image.');
    if (request.text.length + (request.images ?? []).reduce((sum, image) => sum + image.data.length, 0) > CHAT_PROMPT_LIMIT) {
      throw new PaneError('CHAT_PROMPT_TOO_LARGE', 'The message is larger than 8 MiB. Nothing was sent.', 'Send a shorter message or a smaller image.');
    }
    if (request.images?.some(image => !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))) {
      throw new PaneError('CHAT_IMAGE_UNSUPPORTED', 'An attachment is not a PNG, JPEG, WebP or GIF image. Nothing was sent.', 'Attach a supported image, or send text only.');
    }
    if (state.status === 'stopped') {
      throw new PaneError('CHAT_STOPPED', `This chat is stopped${state.problem ? `: ${state.problem.message}` : '.'} Nothing was sent.`, state.problem?.next ?? 'Press Restart to start it again.');
    }
    const receipt: AgentChatReceipt = { operationId: request.operationId, generation: tab.generation, fingerprint, state: 'accepted' };
    // The full prompt goes beside the state first; the receipt and queue entry are then saved together.
    try { this.bodies.write(panelId, request.operationId, { text: request.text, images: request.images }); }
    catch (error) { throw new PaneError('CHAT_PROMPT_NOT_SAVED', `The message could not be saved on this machine (${reasonOf(error)}). Nothing was sent.`, 'Check free disk space, then send it again.'); }
    const queued: ChatTabQueuedPrompt = { operationId: request.operationId, text: request.text.slice(0, QUEUE_PREVIEW), queuedAt: new Date().toISOString(), stored: true };
    if (request.images?.length) queued.imageCount = request.images.length;
    try { this.update(panelId, current => ({ ...current, receipts: [...(current.receipts ?? []), receipt].slice(-RECEIPT_LIMIT), queue: [...(current.queue ?? []), queued] })); }
    catch (error) { this.bodies.remove(panelId, request.operationId); throw error; }
    this.publish(panelId);
    if (tab.runtime?.isAlive()) this.drain(panelId);
    else void this.ensure(panelId).catch(() => undefined);
    return structuredClone(receipt);
  }

  unqueue(panelId: string, operationId: string): void {
    const state = this.required(panelId);
    if (!state.queue?.some(item => item.operationId === operationId)) throw new PaneError('CHAT_NOT_QUEUED', 'That message is no longer waiting; it was already sent or removed.', 'Look at the conversation for it.');
    this.update(panelId, current => ({
      ...current,
      queue: current.queue?.filter(item => item.operationId !== operationId),
      receipts: current.receipts?.map(receipt => receipt.operationId === operationId ? { ...receipt, state: 'failed', error: 'Removed from the queue before it was sent.' } : receipt),
    }));
    this.bodies.remove(panelId, operationId);
    this.publish(panelId);
  }

  async cancel(panelId: string): Promise<void> {
    const runtime = this.liveRuntime(panelId);
    await runtime.cancel();
  }

  answerPermission(panelId: string, requestId: string, optionId: string): void {
    this.liveRuntime(panelId).answerPermission(requestId, optionId);
  }

  answerQuestion(panelId: string, questionId: string, answer: ChatTabAnswer): void {
    this.liveRuntime(panelId).answerQuestion(questionId, answer);
  }

  async configure(panelId: string, configId: string, value: string): Promise<void> {
    const runtime = this.liveRuntime(panelId);
    if (runtime.isRunning()) throw new PaneError('CHAT_CONFIG_BUSY', 'Settings cannot change while the agent is working. Nothing changed.', 'Wait for the turn to end, or press Stop.');
    await runtime.configure(configId, value);
    this.update(panelId, state => ({ ...state, settings: { ...state.settings, [configId]: value } }));
    this.publish(panelId);
  }

  /** `runpane report` from the tab's agent; kept in its state like a terminal agent tab's report. */
  setReport(panelId: string, report: NonNullable<ChatPanelState['agentReport']>): void {
    this.update(panelId, state => ({ ...state, agentReport: report }));
  }

  /** The tab was closed: end its agent and forget its runtime. The agent keeps its own session. */
  async close(panelId: string): Promise<void> {
    const tab = this.tabs.get(panelId);
    if (!tab) return;
    await this.end(tab);
    tab.transcript?.dispose();
    this.bodies.clear(panelId);
    this.tabs.delete(panelId);
    this.options.onClosed?.(panelId);
  }

  /**
   * Ends the tab's agent and leaves it stopped with `reason` (Autopilot turned off or replaced).
   * Unlike a crash it offers no Restart: whatever stopped it starts it again. The conversation is kept.
   */
  async stop(panelId: string, reason: { message: string; next: string }): Promise<void> {
    this.required(panelId);
    const tab = this.tabs.get(panelId);
    if (tab) await this.end(tab);
    this.stopWith(panelId, { code: 'exited', message: reason.message, next: reason.next });
  }

  /** Pane is quitting: end every agent. Saved state is left as it was, so each tab comes back on the next launch. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.tabs.values()].map(tab => this.end(tab)));
  }

  async stopSession(sessionId: string): Promise<void> {
    await Promise.allSettled([...this.tabs.keys()].filter(panelId => this.options.store.panel(panelId)?.sessionId === sessionId).map(panelId => this.close(panelId)));
  }

  private async start(panelId: string, tab: Tab): Promise<void> {
    const panel = this.options.store.panel(panelId);
    if (!panel) throw new PaneError('CHAT_PANEL_MISSING', 'This chat tab no longer exists.', 'Open another chat tab.');
    tab.generation = tab.run = this.lastGeneration = Math.max(Date.now(), this.lastGeneration + 1);
    tab.transcript?.dispose();
    tab.transcript = undefined;
    tab.notice = undefined;
    const generation = tab.generation;
    this.update(panelId, state => ({ ...state, status: 'starting', problem: undefined }));
    this.publish(panelId);
    let launch: ResolvedLaunch;
    let transcript: ChatTranscript;
    try {
      // Inside the try: a chat-tabs folder that cannot be written leaves the tab stopped with Restart, not starting.
      transcript = tab.transcript = new ChatTranscript(panelId, tab.generation, { spoolFile: path.join(this.options.spoolDirectory, safeName(panelId), 'transcript.jsonl'), windowMessages: this.options.windowMessages });
      launch = await this.options.launcher.resolve(panel, this.required(panelId));
    } catch (error) {
      const failure = chatFailure(error, { code: 'CHAT_LAUNCH_FAILED', next: 'Press Restart.' });
      this.stopWith(panelId, problemFrom(failure, this.required(panelId).agent));
      throw failure;
    }
    // Closed or restarted while the launch resolved: start nothing.
    if (tab.run !== generation) return;
    tab.launch = launch;
    const runtime = new ChatTabRuntime({
      command: launch.command,
      generation,
      onUpdate: update => {
        let event: ChatTabEvent | undefined;
        try { event = transcript.accept(update); }
        catch (error) {
          // The agent's own session keeps the update; viewers are told the window may be incomplete.
          console.warn(`[ChatTabs] An update for ${panelId} could not be shown: ${reasonOf(error)}`);
          if (tab.run === generation) { tab.notice = 'Part of this conversation could not be shown. Press Restart to reload it from the agent.'; this.publish(panelId); }
          return;
        }
        if (event && !tab.loading && tab.run === generation) this.options.send('chat-tab:event', event);
      },
      onState: () => { if (tab.run === generation && !tab.loading) this.publish(panelId); },
      onOwnTurn: outcome => { if (tab.run === generation) this.ownTurn(panelId, tab, outcome); },
      onExit: exit => this.exited(panelId, generation, exit),
    });
    tab.runtime = runtime;
    try {
      await runtime.start();
      const state = this.required(panelId);
      const request: NewSessionRequest = { cwd: state.cwd, mcpServers: launch.mcpServers ?? [] };
      if (launch.meta) request._meta = launch.meta;
      if (state.acpSessionId) {
        tab.loading = true;
        try { await runtime.load({ ...request, sessionId: state.acpSessionId }); } finally { tab.loading = false; }
      } else {
        const created = await runtime.create(request);
        this.update(panelId, current => ({ ...current, acpSessionId: created.sessionId, settings: { ...launch.initialSettings, ...current.settings } }));
      }
      if (launch.mode) await runtime.setMode(launch.mode);
      await this.applySettings(panelId, runtime);
      const interrupted = this.required(panelId).turn;
      if (interrupted) {
        transcript.endTurn({ type: 'pane_turn', stopReason: 'interrupted', startedAt: interrupted.startedAt, endedAt: new Date().toISOString() });
        tab.notice = 'The last turn stopped when Pane closed. Send a message to continue.';
        this.update(panelId, current => ({
          ...current, turn: undefined,
          receipts: current.receipts?.map(receipt => receipt.operationId === interrupted.operationId && receipt.state === 'accepted' ? { ...receipt, state: 'failed', error: 'Pane closed before the turn finished.' } : receipt),
        }));
      }
      // Closed or stopped while starting: the tab stays as that left it.
      if (tab.run !== generation) return;
      const { notice } = this.required(panelId);
      if (notice) tab.notice = notice;
      this.update(panelId, current => ({ ...current, status: 'idle', notice: undefined }));
      this.publish(panelId);
      this.sendInitialInput(panelId);
      this.drain(panelId);
    } catch (error) {
      if (tab.run !== generation) return;
      tab.runtime = undefined;
      await runtime.stop().catch(() => undefined);
      const failure = chatFailure(error, { code: 'CHAT_START_FAILED', next: 'Press Restart. If it fails again, check the agent is installed and signed in on this machine.' });
      this.stopWith(panelId, problemFrom(failure, this.required(panelId).agent));
      throw failure;
    }
  }

  private async applySettings(panelId: string, runtime: ChatTabRuntime): Promise<void> {
    const settings = this.required(panelId).settings ?? {};
    for (const [id, value] of Object.entries(settings)) {
      const control = runtime.controls().find(entry => entry.id === id);
      if (!control || control.currentValue === value || !control.options.some(option => option.value === value)) continue;
      try { await runtime.configure(id, value); }
      catch (error) { console.warn(`[ChatTabs] Could not apply ${id}=${value} to ${panelId}: ${reasonOf(error)}. The agent's own setting is kept.`); }
    }
  }

  private sendInitialInput(panelId: string): void {
    const state = this.required(panelId);
    if (!state.initialInput || state.initialInputSentAt) return;
    const operationId = `initial:${panelId}`;
    // Marked only once the prompt is accepted. A start that dies in between sends it
    // again with the same ID, which returns the first receipt instead of a second prompt.
    try { this.send(panelId, { operationId, text: state.initialInput }); }
    catch (error) {
      console.warn(`[ChatTabs] The first message for ${panelId} was not sent: ${reasonOf(error)}.`);
      this.tab(panelId).notice = `The opening message was not sent: ${error instanceof PaneError ? `${error.message} ${error.next ?? ''}`.trim() : reasonOf(error)} Press Restart to try it again.`;
      this.publish(panelId);
      return;
    }
    this.update(panelId, current => ({ ...current, initialInputSentAt: new Date().toISOString() }));
  }

  /** Delivers the next queued prompt when the agent is free. */
  private drain(panelId: string): void {
    const tab = this.tab(panelId);
    const runtime = tab.runtime;
    const state = this.required(panelId);
    if (!runtime?.isAlive() || runtime.isRunning() || runtime.isWorkingAlone() || tab.delivering || tab.loading || state.status === 'starting' || state.status === 'stopped') return;
    const next = state.queue?.[0];
    if (!next) return;
    const body = next.stored ? this.bodies.read(panelId, next.operationId) : { text: next.text, images: next.images };
    if (!body) {
      this.update(panelId, current => ({
        ...current, queue: current.queue?.slice(1),
        receipts: current.receipts?.map(receipt => receipt.operationId === next.operationId ? { ...receipt, state: 'failed', error: 'The saved copy of this queued message is missing, so it was not sent.' } : receipt),
      }));
      this.publish(panelId);
      this.drain(panelId);
      return;
    }
    tab.delivering = true;
    const generation = tab.generation;
    const content: ContentBlock[] = [
      ...(body.text ? [{ type: 'text' as const, text: body.text }] : []),
      ...(body.images ?? []).map(image => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data })),
    ];
    const startedAt = new Date().toISOString();
    for (const event of tab.transcript?.userMessage(next.operationId, content) ?? []) this.options.send('chat-tab:event', event);
    this.update(panelId, current => ({ ...current, queue: current.queue?.slice(1), turn: { operationId: next.operationId, startedAt }, status: 'working' }));
    this.bodies.remove(panelId, next.operationId);
    const finish = (outcome: 'completed' | 'failed', stopReason: string, error?: PaneError) => {
      tab.delivering = false;
      if (tab.run !== generation || !this.options.store.state(panelId)) return;
      const marker = tab.transcript?.endTurn({ type: 'pane_turn', stopReason, startedAt, endedAt: new Date().toISOString() });
      if (marker) this.options.send('chat-tab:event', marker);
      tab.notice = stopReason === 'refusal' ? 'The agent declined this request.' : stopReason === 'max_tokens' ? 'The reply hit the length limit.' : stopReason === 'max_turn_requests' ? 'The turn hit its step limit.' : undefined;
      this.update(panelId, current => ({
        ...current, turn: undefined, status: current.status === 'stopped' ? 'stopped' : 'idle',
        receipts: current.receipts?.map(receipt => receipt.operationId === next.operationId ? { ...receipt, state: outcome, error: error?.message } : receipt),
      }));
      if (error && isAuthRequired(error)) {
        void this.release(tab).then(() => this.stopWith(panelId, signedOut(this.required(panelId).agent)));
        return;
      }
      this.publish(panelId);
      this.drain(panelId);
    };
    this.publish(panelId);
    void runtime.prompt(content).then(result => finish('completed', result.stopReason), error => { void runtime.exitsWithin(250).then(exited => finish('failed', exited ? 'exited' : 'error', chatFailure(error))); });
  }

  /**
   * The agent started or ended a turn with no prompt open. What the person sends
   * meanwhile waits in the queue, so it lands below everything that turn does (D-193).
   */
  private ownTurn(panelId: string, tab: Tab, outcome: 'started' | 'end_turn' | 'cancelled' | 'error'): void {
    if (outcome === 'started') tab.ownTurnStartedAt = new Date().toISOString();
    else if (tab.ownTurnStartedAt) {
      const marker = tab.transcript?.endTurn({ type: 'pane_turn', stopReason: outcome, startedAt: tab.ownTurnStartedAt, endedAt: new Date().toISOString() });
      tab.ownTurnStartedAt = undefined;
      if (marker && !tab.loading) this.options.send('chat-tab:event', marker);
    }
    if (tab.loading) return;
    this.publish(panelId);
    if (outcome !== 'started') this.drain(panelId);
  }

  private exited(panelId: string, generation: number, exit: RuntimeExit): void {
    const tab = this.tabs.get(panelId);
    if (!tab || tab.run !== generation || exit.expected) return;
    tab.runtime = undefined;
    if (!this.options.store.state(panelId)) return;
    const detail = exit.stderr.split('\n').filter(Boolean).at(-1);
    this.stopWith(panelId, { code: 'exited', message: `${exit.message}${detail ? ` Last output: ${detail}` : ''}`, next: 'Press Restart to start it again. The conversation is kept.', action: 'restart' });
  }

  private stopWith(panelId: string, problem: ChatTabProblem): void {
    if (!this.options.store.state(panelId)) return;
    this.update(panelId, state => ({ ...state, status: 'stopped', problem, turn: undefined }));
    this.publish(panelId);
  }

  /**
   * Ends the tab's agent without waiting for a start to finish: the release makes the
   * start give up, and the wait for it and the agent is capped so a hung adapter cannot hold up a quit.
   */
  private async end(tab: Tab): Promise<void> {
    const starting = tab.starting;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ending = (async () => {
      await this.release(tab);
      await starting?.catch(() => undefined);
      // A restart racing this may have started another runtime meanwhile.
      await this.release(tab);
    })();
    await Promise.race([ending, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.stopTimeoutMs ?? 5000); })]);
    clearTimeout(timer);
  }

  private async release(tab: Tab): Promise<void> {
    const runtime = tab.runtime;
    tab.runtime = undefined;
    tab.delivering = false;
    // Outcomes that arrive while stopping belong to no runtime: a turn cut off by a
    // quit stays recorded, so the next start can say it stopped. The public generation
    // is kept, so viewers accept the stopped state published next.
    tab.run = 0;
    await runtime?.stop();
  }

  private liveRuntime(panelId: string): ChatTabRuntime {
    this.required(panelId);
    const runtime = this.tabs.get(panelId)?.runtime;
    if (!runtime?.isAlive()) throw new PaneError('CHAT_NOT_RUNNING', 'This chat\'s agent is not running. Nothing was sent.', 'Press Restart, or wait for the tab to finish starting.');
    return runtime;
  }

  private snapshot(panelId: string, state: ChatPanelState, tab: Tab, limit: number): ChatTabView {
    const runtime = tab.runtime?.isAlive() && !tab.loading ? tab.runtime : undefined;
    const permissions = runtime ? runtime.permissions().map(permission => ({
      id: permission.id, generation: tab.generation,
      title: permission.request.toolCall.title ?? 'Approval needed',
      toolCall: decodeBoundary(permission.request.toolCall, boundary.json),
      options: permission.request.options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
    })) : [];
    const questions = runtime ? runtime.questions().map(question => ({
      id: question.id, generation: tab.generation, message: question.request.message,
      schema: 'requestedSchema' in question.request ? decodeBoundary(question.request.requestedSchema, boundary.json) : {},
      toolCallId: decodeOptionalBoundary(question.request, boundary.object({ toolCallId: boundary.optional(boundary.string) }))?.toolCallId,
    })) : [];
    return {
      panelId, agent: state.agent, generation: tab.generation, status: this.status(state, tab), problem: state.problem, notice: tab.notice,
      canAttachImages: tab.runtime?.supportsImages() ?? false,
      controls: runtime?.controls() ?? [], commands: runtime?.commands() ?? [],
      permissions, questions, queue: state.queue ?? [],
      // While history replays the window is incomplete; viewers fetch it once the tab has started.
      transcript: tab.transcript && limit > 0 && !tab.loading && !tab.starting ? tab.transcript.snapshot(limit) : undefined,
      messageCount: tab.transcript?.count() ?? 0,
    };
  }

  private status(state: ChatPanelState, tab: Tab): ChatTabStatus {
    if (state.status === 'stopped') return 'stopped';
    if (tab.starting || tab.loading || !tab.runtime) return tab.runtime || tab.starting ? 'starting' : state.status === 'starting' ? 'starting' : 'idle';
    if (tab.runtime.permissions().length || tab.runtime.questions().length) return 'blocked';
    return tab.runtime.isRunning() || tab.runtime.isWorkingAlone() || tab.delivering ? 'working' : 'idle';
  }

  private publish(panelId: string): void {
    const state = this.options.store.state(panelId);
    if (!state) return;
    const tab = this.tab(panelId);
    const view = this.snapshot(panelId, state, tab, 0);
    this.options.send('chat-tab:state', view);
    this.options.onView?.(view);
    const agentState = toAgentState(view);
    if (tab.published === agentState) return;
    const previous = tab.published;
    tab.published = agentState;
    const panel = this.options.store.panel(panelId);
    if (!panel) return;
    const event: PanelAgentStatusEvent = {
      panelId, sessionId: panel.sessionId, agentType: state.agent, state: agentState,
      reason: agentState === 'blocked' ? view.problem?.message ?? (view.questions.length ? 'Agent asked a question' : 'Agent asked for approval') : null,
      workedVisibly: agentState === 'idle' ? previous === 'working' : undefined,
    };
    this.options.send('panel:agentStatus', event);
    this.options.onStatus?.(event);
  }

  private tab(panelId: string): Tab {
    let tab = this.tabs.get(panelId);
    if (!tab) { tab = { generation: 0, run: 0, loading: false, delivering: false }; this.tabs.set(panelId, tab); }
    return tab;
  }

  private required(panelId: string): ChatPanelState {
    const state = this.options.store.state(panelId);
    if (!state) throw new PaneError('CHAT_PANEL_MISSING', 'This chat tab no longer exists.', 'Open another chat tab.');
    return state;
  }

  private update(panelId: string, change: (state: ChatPanelState) => ChatPanelState): void {
    this.options.store.commit(panelId, change(this.required(panelId)));
  }
}

function toAgentState(view: ChatTabView): AgentState {
  if (view.status === 'blocked' || (view.status === 'stopped' && view.problem)) return 'blocked';
  if (view.status === 'working' || view.status === 'starting') return 'working';
  return view.status === 'idle' ? 'idle' : 'unknown';
}

function safeName(panelId: string): string { return createHash('sha256').update(panelId).digest('hex').slice(0, 32); }

function signedOut(agent: ChatPanelState['agent']): ChatTabProblem {
  const name = agent === 'claude' ? 'Claude Code' : 'Codex';
  return { code: 'signed-out', message: `${name} is not signed in on this machine.`, next: `Sign in with ${agent === 'claude' ? 'claude auth login' : 'codex login'} in a terminal tab, then press Retry.`, action: 'sign-in' };
}

function problemFrom(error: PaneError, agent: ChatPanelState['agent']): ChatTabProblem {
  if (isAuthRequired(error)) return signedOut(agent);
  if (error.code === 'CHAT_AGENT_NOT_INSTALLED') return { code: 'not-installed', message: error.message, next: error.next ?? 'Install it, then press Retry.', action: 'install', url: agent === 'claude' ? 'https://docs.anthropic.com/en/docs/claude-code/setup' : 'https://developers.openai.com/codex/cli' };
  if (error.code === 'CHAT_UNSUPPORTED_HOST') return { code: 'unsupported-host', message: error.message, next: error.next ?? 'Open a terminal agent tab instead.' };
  // #1236: the adapters ship with Pane and check the installed CLI. Too old a CLI is fixed by installing a newer one.
  if (error.code === 'CHAT_AGENT_OUTDATED') return { code: 'not-installed', message: error.message, next: error.next ?? 'Update it, then press Retry.', action: 'install', url: agent === 'claude' ? 'https://docs.anthropic.com/en/docs/claude-code/setup' : 'https://developers.openai.com/codex/cli' };
  if (error.code === 'CHAT_ADAPTER_MISSING') return { code: 'adapter-setup', message: error.message, next: error.next ?? 'Reinstall Pane from runpane.com.' };
  return { code: 'failed', message: error.message, next: error.next ?? 'Press Restart.', action: 'restart' };
}
