import {
  client, methods, RequestError, type ClientConnection, type ContentBlock, type CreateElicitationRequest, type CreateElicitationResponse,
  type InitializeResponse, type LoadSessionRequest, type LoadSessionResponse, type NewSessionRequest, type NewSessionResponse,
  type PromptResponse, type AnyMessage, type Stream, type RequestPermissionRequest, type SessionNotification, type RequestPermissionResponse, type SessionConfigOption, type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import type { ChatTabCommand, ChatTabContextUsage, ChatTabTask } from '../../../../shared/types/chatTab';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { AgentProcess, type AgentCommand } from './agentProcess';

export interface PendingPermission { id: string; request: RequestPermissionRequest }
export interface PendingQuestion { id: string; request: CreateElicitationRequest }
export interface RuntimeExit { expected: boolean; message: string; stderr: string }

export interface ChatTabRuntimeOptions {
  command: AgentCommand;
  generation: number;
  requestTimeoutMs?: number;
  onUpdate: (update: SessionUpdate) => void;
  onState: () => void;
  /** The agent started or ended a turn of its own; ending says how. */
  onOwnTurn?: (outcome: 'started' | 'end_turn' | 'cancelled' | 'error') => void;
  onExit: (exit: RuntimeExit) => void;
}

/** ACP's JSON-RPC code for "authentication required". */
const AUTH_REQUIRED = RequestError.authRequired().code;
const rpcError = boundary.object({ code: boundary.number, message: boundary.optional(boundary.string) });

/**
 * Every failure that leaves the runtime is a PaneError. An ACP authRequired
 * error becomes CHAT_NOT_SIGNED_IN, which the tab shows as its sign-in state.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Rejections from the ACP connection are parsed here, at the protocol boundary.
export function chatFailure(cause: unknown, fallback: { code: string; next: string } = { code: 'CHAT_AGENT_FAILED', next: 'Press Restart.' }): PaneError {
  if (cause instanceof PaneError) return cause;
  const rpc = decodeOptionalBoundary(cause, rpcError);
  if (rpc?.code === AUTH_REQUIRED) return new PaneError('CHAT_NOT_SIGNED_IN', 'The agent is not signed in on this machine.', 'Sign in with the agent\'s own login in a terminal tab, then press Retry.');
  return new PaneError(fallback.code, `The agent reported an error: ${reasonOf(cause)}.`, fallback.next);
}

export function isAuthRequired(error: PaneError): boolean { return error.code === 'CHAT_NOT_SIGNED_IN'; }

/** claude-agent-acp's extension: stops a task; for the task of an agent's own turn, it interrupts the turn. */
const ASYNC_TASK_STOP = '_session/async_task/stop';
const OWN_TURN_ENDS = new Set(['completed', 'failed', 'stopped']);
const asyncTaskUpdate = boundary.object({
  sessionUpdate: boundary.union(boundary.literal('async_task_spawned'), boundary.literal('async_task_progress'), boundary.literal('async_task_state_update')),
  asyncTaskId: boundary.string, taskType: boundary.optional(boundary.string), state: boundary.optional(boundary.string),
  name: boundary.optional(boundary.string), description: boundary.optional(boundary.string), canStop: boundary.optional(boundary.boolean),
});
const stopResult = boundary.object({ stopped: boundary.optional(boundary.boolean) });
/**
 * The SDK refuses session updates outside the ACP schema, and claude-agent-acp's async
 * task updates are. They travel under a method of Pane's own, in place in the stream,
 * so one still arrives in order with the updates around it.
 */
const ASYNC_TASK_NOTIFICATION = '_pane/async_task';
const asyncTaskParams = boundary.object({ sessionId: boundary.string, update: asyncTaskUpdate });
const taskMessage = boundary.object({ method: boundary.literal('session/update'), params: asyncTaskParams });
function withAsyncTasks(stream: Stream): Stream {
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        // SAFETY: only the method changes, on a message just checked to be a notification.
        controller.enqueue(decodeOptionalBoundary(message, taskMessage) ? { ...message, method: ASYNC_TASK_NOTIFICATION } as AnyMessage : message);
      },
    })),
  };
}
type AsyncTaskUpdate = { sessionUpdate: string; asyncTaskId: string; taskType?: string; state?: string; name?: string; description?: string; canStop?: boolean };

/**
 * One chat tab's ACP client connection to its adapter process. It never holds
 * a terminal and never hands its session to one (D-20).
 */
export class ChatTabRuntime {
  private readonly process: AgentProcess;
  private connection?: ClientConnection;
  private initialization?: InitializeResponse;
  private sessionId?: string;
  private configOptions: SessionConfigOption[] = [];
  private availableCommands: ChatTabCommand[] = [];
  /** The adapter's last `usage_update`; a new conversation has none until it reports. */
  private contextUsage?: ChatTabContextUsage;
  /** Background work beside the turns (claude-agent-acp's async tasks other than a turn of its own). */
  private readonly backgroundTasks = new Map<string, ChatTabTask>();
  private readonly permissionRequests = new Map<string, { permission: PendingPermission; resolve: (response: RequestPermissionResponse) => void }>();
  private readonly questionRequests = new Map<string, { question: PendingQuestion; resolve: (response: CreateElicitationResponse) => void }>();
  private running = false;
  /** A turn the agent started by itself, with no prompt open (D-193). */
  private ownTurn?: string;
  private creating = false;
  private early: SessionNotification[] = [];
  private stopping = false;
  private sequence = 0;

  constructor(private readonly options: ChatTabRuntimeOptions) {
    this.process = new AgentProcess(options.command);
  }

  get generation(): number { return this.options.generation; }
  get pid(): number | undefined { return this.process.pid; }
  get session(): string | undefined { return this.sessionId; }
  isRunning(): boolean { return this.running; }
  /** The agent is working on a turn of its own, for example after a background task finished. */
  isWorkingAlone(): boolean { return this.ownTurn !== undefined; }
  isAlive(): boolean { return this.process.running && !this.stopping; }
  supportsImages(): boolean { return this.initialization?.agentCapabilities?.promptCapabilities?.image === true; }
  canLoad(): boolean { return this.initialization?.agentCapabilities?.loadSession === true; }

  async start(): Promise<InitializeResponse> {
    await this.process.started();
    this.connection = client({ name: 'pane' })
      .onNotification(methods.client.session.update, ({ params }) => {
        // An adapter may send updates (its command list) before Pane has read the
        // session/new reply that names the session; hold them until it has.
        if (this.creating && !this.sessionId) { this.early.push(params); return; }
        this.receive(params);
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => {
        if (params.sessionId !== this.sessionId || signal.aborted) return { outcome: { outcome: 'cancelled' } };
        const id = `${this.options.generation}:p${++this.sequence}`;
        return new Promise<RequestPermissionResponse>(resolve => {
          const abort = () => { this.permissionRequests.delete(id); resolve({ outcome: { outcome: 'cancelled' } }); this.options.onState(); };
          signal.addEventListener('abort', abort, { once: true });
          this.permissionRequests.set(id, { permission: { id, request: params }, resolve: response => { signal.removeEventListener('abort', abort); resolve(response); } });
          this.options.onState();
        });
      })
      .onRequest(methods.client.elicitation.create, ({ params, signal }) => {
        if (params.mode !== 'form' || ('sessionId' in params && params.sessionId !== this.sessionId) || signal.aborted) return { action: 'decline' };
        const id = `${this.options.generation}:q${++this.sequence}`;
        return new Promise<CreateElicitationResponse>(resolve => {
          const abort = () => { this.questionRequests.delete(id); resolve({ action: 'cancel' }); this.options.onState(); };
          signal.addEventListener('abort', abort, { once: true });
          this.questionRequests.set(id, { question: { id, request: params }, resolve: response => { signal.removeEventListener('abort', abort); resolve(response); } });
          this.options.onState();
        });
      })
      .onNotification(ASYNC_TASK_NOTIFICATION, { parse: value => decodeBoundary(value, asyncTaskParams) }, ({ params }) => { if (params.sessionId === this.sessionId) this.asyncTask(params.update); })
      .connect(withAsyncTasks(this.process.stream));
    void this.process.exited.then(exit => {
      this.withdraw();
      this.running = false;
      this.ownTurn = undefined;
      this.backgroundTasks.clear();
      const expected = this.stopping;
      const reason = exit.error ? exit.error.message : exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`;
      this.options.onExit({ expected, message: `The agent ${reason}.`, stderr: this.process.stderrTail() });
    });
    try {
      this.initialization = await this.bounded(this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: 'pane', version: '1' },
        // Form elicitation lets Claude ask AskUserQuestion and plan questions as cards.
        // terminal_output_delta: claude-agent-acp streams command output into the step's row.
        // asyncTasks: ACP has no session state, so this is the only sign that claude-agent-acp works on a turn of its own.
        clientCapabilities: { elicitation: { form: {} }, _meta: { terminal_output_delta: true, jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } } },
      }));
    } catch (error) {
      const stderr = this.process.stderrTail().split('\n').filter(Boolean).at(-1);
      const failure = chatFailure(error, { code: 'CHAT_ADAPTER_START_FAILED', next: 'Press Restart. If it fails again, check that the agent is installed on this machine.' });
      throw stderr && failure.code === 'CHAT_ADAPTER_START_FAILED' ? new PaneError(failure.code, `${failure.message} Last output: ${stderr}`, failure.next) : failure;
    }
    return this.initialization;
  }

  async create(request: NewSessionRequest): Promise<NewSessionResponse> {
    this.creating = true;
    let response: NewSessionResponse;
    try {
      response = await this.bounded(this.agent().request(methods.agent.session.new, request)).catch(error => { throw chatFailure(error); });
    } finally { this.creating = false; }
    this.sessionId = response.sessionId;
    this.configOptions = response.configOptions ?? [];
    for (const params of this.early.splice(0)) this.receive(params);
    this.options.onState();
    return response;
  }

  /** Loads a saved conversation; the agent replays its history as updates before this resolves. */
  async load(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!this.canLoad()) throw new PaneError('CHAT_LOAD_UNSUPPORTED', 'This agent adapter cannot reopen a saved conversation.', 'Start a new chat tab, or update the adapter.');
    this.sessionId = request.sessionId;
    // History replay of a long session can take a while; it is bounded by the process, not a timer.
    const response = await this.agent().request(methods.agent.session.load, request).catch(error => { throw chatFailure(error); });
    this.configOptions = response.configOptions ?? [];
    this.options.onState();
    return response;
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    if (!this.sessionId) throw new PaneError('CHAT_NOT_READY', 'The conversation has not started yet. Nothing was sent.', 'Wait for the tab to finish starting.');
    if (this.running) throw new PaneError('CHAT_TURN_RUNNING', 'The agent is already working. Nothing was sent.', 'Wait for the turn to end, or press Stop.');
    this.running = true;
    this.options.onState();
    try {
      return await this.agent().request(methods.agent.session.prompt, { sessionId: this.sessionId, prompt: content }).catch(error => { throw chatFailure(error, { code: 'CHAT_TURN_FAILED', next: 'Send the message again, or press Restart if the agent stopped.' }); });
    } finally {
      this.running = false;
      this.options.onState();
    }
  }

  async cancel(): Promise<void> {
    this.withdraw();
    if (!this.sessionId || !this.process.running) return;
    if (this.ownTurn && !this.running) { await this.bounded(this.agent().request(ASYNC_TASK_STOP, { sessionId: this.sessionId, asyncTaskId: this.ownTurn })).catch(error => { throw chatFailure(error); }); return; }
    await this.agent().notify(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  permissions(): PendingPermission[] { return [...this.permissionRequests.values()].map(entry => entry.permission); }
  questions(): PendingQuestion[] { return [...this.questionRequests.values()].map(entry => entry.question); }

  answerPermission(id: string, optionId: string): void {
    const pending = this.permissionRequests.get(id);
    if (!pending) throw new PaneError('CHAT_PERMISSION_ALREADY_ANSWERED', 'This approval was already answered or withdrawn. Nothing was sent.', 'Look at the conversation for the agent\'s current request.');
    if (!pending.permission.request.options.some(option => option.optionId === optionId)) {
      throw new PaneError('CHAT_PERMISSION_OPTION_INVALID', 'That answer is not one of the choices the agent offered. Nothing was sent.', 'Pick one of the shown choices.');
    }
    this.permissionRequests.delete(id);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    this.options.onState();
  }

  answerQuestion(id: string, response: CreateElicitationResponse): void {
    const pending = this.questionRequests.get(id);
    if (!pending) throw new PaneError('CHAT_QUESTION_ALREADY_ANSWERED', 'This question was already answered or withdrawn. Nothing was sent.', 'Look at the conversation for the agent\'s current question.');
    this.questionRequests.delete(id);
    pending.resolve(response);
    this.options.onState();
  }

  async configure(configId: string, value: string): Promise<void> {
    if (!this.sessionId) throw new PaneError('CHAT_NOT_READY', 'The conversation has not started yet. Nothing changed.', 'Wait for the tab to finish starting.');
    const option = this.configOptions.find(entry => entry.id === configId);
    const values = option?.type === 'select' ? option.options.flatMap(entry => 'group' in entry ? entry.options.map(choice => choice.value) : [entry.value]) : [];
    if (!values.includes(value)) throw new PaneError('CHAT_CONFIG_UNSUPPORTED', `The agent does not offer "${value}" for ${option?.name ?? configId}. Nothing changed.`, 'Pick one of the listed choices.');
    const result = await this.bounded(this.agent().request(methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId, value }));
    this.configOptions = result.configOptions;
    this.options.onState();
  }

  /** Selects a session mode (ACP session/set_mode), such as a profile's bypassPermissions. */
  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) throw new PaneError('CHAT_NOT_READY', 'The conversation has not started yet. The mode was not set.', 'Wait for the tab to finish starting.');
    await this.bounded(this.agent().request(methods.agent.session.setMode, { sessionId: this.sessionId, modeId })).catch(error => {
      throw chatFailure(error, { code: 'CHAT_MODE_REFUSED', next: 'Press Restart. If it fails again, check the profile\'s permission mode.' });
    });
    this.options.onState();
  }

  controls(): AgentChatConfigOption[] {
    return this.configOptions.flatMap(option => {
      if (option.type !== 'select') return [];
      const control: AgentChatConfigOption = {
        id: option.id, name: option.name, currentValue: option.currentValue,
        options: option.options.flatMap(entry => 'group' in entry ? entry.options : [entry]).map(choice => ({ value: choice.value, name: choice.name })),
      };
      // The composer places mode, model and effort by ACP's category.
      if (option.category) control.category = option.category;
      return [control];
    });
  }

  commands(): ChatTabCommand[] { return this.availableCommands; }
  usage(): ChatTabContextUsage | undefined { return this.contextUsage ? { ...this.contextUsage } : undefined; }
  tasks(): ChatTabTask[] { return [...this.backgroundTasks.values()].map(task => ({ ...task })); }

  /** Stops one background task (claude-agent-acp's `_session/async_task/stop`); the turn goes on. */
  async stopTask(taskId: string): Promise<void> {
    if (!this.backgroundTasks.has(taskId) || !this.sessionId) throw new PaneError('CHAT_TASK_NOT_RUNNING', 'That background task is no longer running; it already finished or was stopped.', 'Look at the conversation for what it did.');
    const result = await this.bounded(this.agent().request(ASYNC_TASK_STOP, { sessionId: this.sessionId, asyncTaskId: taskId })).catch(error => { throw chatFailure(error); });
    if (decodeOptionalBoundary(result, stopResult)?.stopped === false) {
      throw new PaneError('CHAT_TASK_NOT_STOPPED', 'The agent did not stop that background task; it may be finishing, or it cannot be stopped from here.', 'Wait for it to end, or ask the agent to stop it.');
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.withdraw();
    try {
      if (this.sessionId && this.process.running && this.initialization?.agentCapabilities?.sessionCapabilities?.close) {
        await this.bounded(this.agent().request(methods.agent.session.close, { sessionId: this.sessionId }), 2000).catch(() => undefined);
      }
    } finally {
      this.connection?.close();
      await this.process.stop();
    }
  }

  stderr(): string { return this.process.stderrTail(); }

  /** Whether the adapter process ends within `ms`: a turn that fails as its process dies stopped because it exited. */
  async exitsWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([this.process.exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    if (timer) clearTimeout(timer);
    return exited;
  }

  private receive(params: SessionNotification): void {
    if (params.sessionId !== this.sessionId) return;
    const update = params.update;
    if (update.sessionUpdate === 'config_option_update') { this.configOptions = update.configOptions; this.options.onState(); }
    if (update.sessionUpdate === 'usage_update') { this.contextUsage = { used: update.used, size: update.size }; this.options.onState(); }
    if (update.sessionUpdate === 'available_commands_update') {
      this.availableCommands = update.availableCommands.map(command => ({ name: command.name, description: command.description, hint: command.input && 'hint' in command.input ? command.input.hint : undefined }));
      this.options.onState();
    }
    this.options.onUpdate(update);
  }

  /**
   * Background work has its own lifecycle and no row in the conversation: a turn of the agent's
   * own gates the queue, and any other task is listed beside the conversation until it ends.
   */
  private asyncTask(task: AsyncTaskUpdate): void {
    if (task.sessionUpdate === 'async_task_spawned' && task.taskType === 'turn') {
      this.ownTurn = task.asyncTaskId;
      this.options.onOwnTurn?.('started');
    } else if (task.sessionUpdate === 'async_task_state_update' && task.asyncTaskId === this.ownTurn && OWN_TURN_ENDS.has(task.state ?? '')) {
      this.ownTurn = undefined;
      this.options.onOwnTurn?.(task.state === 'completed' ? 'end_turn' : task.state === 'stopped' ? 'cancelled' : 'error');
    } else if (task.sessionUpdate === 'async_task_spawned' && !OWN_TURN_ENDS.has(task.state ?? '')) {
      const entry: ChatTabTask = { id: task.asyncTaskId, kind: task.taskType ?? 'task', startedAt: new Date().toISOString() };
      const title = task.description ?? task.name;
      if (title) entry.title = title;
      if (task.canStop === false) entry.canStop = false;
      this.backgroundTasks.set(task.asyncTaskId, entry);
      this.options.onState();
    } else if (task.sessionUpdate === 'async_task_progress') {
      const known = this.backgroundTasks.get(task.asyncTaskId);
      if (!known || !task.description || known.title === task.description) return;
      this.backgroundTasks.set(task.asyncTaskId, { ...known, title: task.description });
      this.options.onState();
    } else if (task.sessionUpdate === 'async_task_state_update' && OWN_TURN_ENDS.has(task.state ?? '') && this.backgroundTasks.delete(task.asyncTaskId)) {
      this.options.onState();
    }
  }

  private agent(): ClientConnection['agent'] {
    if (!this.connection) throw new PaneError('CHAT_NOT_READY', 'The agent adapter has not started.', 'Press Restart.');
    return this.connection.agent;
  }

  private withdraw(): void {
    for (const entry of this.permissionRequests.values()) entry.resolve({ outcome: { outcome: 'cancelled' } });
    for (const entry of this.questionRequests.values()) entry.resolve({ action: 'cancel' });
    const changed = this.permissionRequests.size + this.questionRequests.size > 0;
    this.permissionRequests.clear();
    this.questionRequests.clear();
    if (changed) this.options.onState();
  }


  private async bounded<T>(operation: Promise<T>, ms = this.options.requestTimeoutMs ?? 60_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PaneError('CHAT_ADAPTER_TIMEOUT', 'The agent adapter did not answer in time.', 'Press Restart to start it again.')), ms);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
