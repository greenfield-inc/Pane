import type { WebSocket } from 'ws';
import type { ContentBlock, ForkSessionRequest, LoadSessionRequest, NewSessionRequest, PromptResponse } from '@agentclientprotocol/sdk/unstable';
import { PaneError } from '../../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { AgentChatConfigOption, AgentChatEvent, AgentChatMessage, AgentChatPart, AgentChatPermission } from '../../../../shared/types/agentChat';

function object(value: JsonValue | undefined): JsonObject { return decodeBoundary(value, boundary.jsonObject); }
function string(value: JsonValue | undefined): string { return decodeBoundary(value, boundary.string); }
function array(value: JsonValue | undefined): JsonValue[] { return decodeBoundary(value, boundary.array(boundary.json)); }
const envelopeSchema = boundary.object({
  method: boundary.optional(boundary.string),
  id: boundary.optional(boundary.union(boundary.string, boundary.number)),
  params: boundary.optional(boundary.jsonObject),
  result: boundary.optional(boundary.jsonObject),
  error: boundary.optional(boundary.object({ message: boundary.string })),
});
type CodexEnvelope = ReturnType<typeof envelopeSchema.decode>;

export interface CodexSessionOptions {
  onIdentity?: (id: string) => void;
  onChange?: (change: AgentChatEvent['change']) => void;
  onState?: () => void;
  onDisconnect?: () => void;
  requestTimeoutMs?: number;
}

/** Native app-server protocol. Policy stays native: attaching and sending do not
 * rewrite approval reviewers, sandbox roots, profiles or provider configuration. */
export class CodexSession {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly approvals = new Map<string, { wireId: string | number; permission: AgentChatPermission; answers: Map<string, JsonValue> }>();
  private threadId?: string;
  private unhandledInteraction?: { id: string | number; message: string };
  private turnId?: string;
  private settings: JsonObject = {};
  private models: JsonObject[] = [];
  private loaded = false;
  private configuring = false;
  private closing = false;
  private hydrating = false;
  private buffered: Array<{ method: string; params: JsonObject }> = [];
  private turnResult?: { resolve: (value: PromptResponse) => void; reject: (error: Error) => void };
  private readonly completed = new Map<string, JsonObject>();

  constructor(private readonly socket: WebSocket, public generation: number, private readonly options: CodexSessionOptions = {}) {
    socket.on('message', data => {
      try { this.receive(decodeBoundary(JSON.parse(data.toString()), envelopeSchema)); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); socket.close(); }
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => { this.loaded = false; this.fail(new PaneError('CHAT_CONNECTION_CLOSED', 'The Codex connection closed.', 'Reconnect to the saved conversation before sending another turn.')); if (!this.closing) options.onDisconnect?.(); });
  }

  setGeneration(generation: number): void {
    this.generation = generation;
    const approvals = [...this.approvals.values()];
    this.approvals.clear();
    for (const approval of approvals) {
      const id = `${generation}:${JSON.stringify(approval.wireId)}`;
      this.approvals.set(id, { ...approval, permission: { ...approval.permission, id, generation } });
    }
  }

  async verifyLoaded(id: string): Promise<void> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await this.request('thread/loaded/list', cursor ? { cursor, limit: 100 } : { limit: 100 });
      if (array(response.data).includes(id)) return;
      cursor = decodeOptionalBoundary(response.nextCursor, boundary.string);
      if (cursor && seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new PaneError('CHAT_IDENTITY_UNAVAILABLE', 'That conversation is not active on the identified Codex server. No saved conversation was loaded.', 'Copy the current Session ID and server socket from /status in this tab.');
  }

  async verifyIdentity(id: string): Promise<void> {
    const response = await this.request('thread/read', { threadId: id });
    if (!this.loaded || id !== this.threadId || object(response.thread).id !== id) throw new PaneError('CHAT_IDENTITY_MISMATCH', 'Codex did not confirm the active conversation.', 'Reconnect before switching interfaces.');
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.turnResult?.reject(error); this.turnResult = undefined;
    this.approvals.clear(); this.options.onState?.();
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PaneError('CHAT_CODEX_TIMEOUT', `Codex did not acknowledge ${method}. Its state is unconfirmed.`, 'Refresh the conversation before retrying any action.'));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }

  private receive(message: CodexEnvelope): void {
    if (message.method !== undefined) {
      const params = object(message.params ?? {});
      if (message.id !== undefined) this.serverRequest(message.id, message.method, params);
      else if (this.hydrating) this.buffered.push({ method: message.method, params });
      else this.notification(message.method, params);
      return;
    }
    const id = decodeOptionalBoundary(message.id, boundary.number);
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    if (message.error) { pending.reject(new PaneError('CHAT_CODEX_REQUEST_FAILED', message.error.message, 'Inspect the provider response and retry explicitly.')); }
    else pending.resolve(object(message.result ?? {}));
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'pane', version: '1' }, capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: 'initialized' }));
    let cursor: string | null = null;
    do {
      const params: JsonObject = {};
      if (cursor) params.cursor = cursor;
      const response = await this.request('model/list', params);
      this.models.push(...array(response.data).map(object));
      cursor = decodeOptionalBoundary(response.nextCursor, boundary.string) ?? null;
    } while (cursor);
  }

  async create(request: NewSessionRequest, title = 'Pane conversation'): Promise<{ sessionId: string }> {
    // The legacy history contract supports full native resume on servers whose
    // paginated listing is incomplete. This selects storage for a NEW thread;
    // existing conversations retain their provider's history format.
    const created = await this.attach('thread/start', { cwd: request.cwd, historyMode: 'legacy', ephemeral: false });
    if (object(this.settings.thread).historyMode !== 'legacy') throw new PaneError('CHAT_CODEX_HISTORY_UNSUPPORTED', 'Codex did not confirm the requested history format. Its new conversation ID is saved.', 'Inspect the provider capability error before recovering this conversation.');
    // Saving the actual tab title materializes an empty native rollout without
    // injecting history or asking the model a dummy question.
    await this.request('thread/name/set', { threadId: created.sessionId, name: title });
    return created;
  }

  async load(request: LoadSessionRequest): Promise<{ sessionId: string }> {
    return this.attach('thread/resume', { threadId: request.sessionId });
  }

  async fork(request: ForkSessionRequest): Promise<{ sessionId: string }> {
    if (this.isRunning()) await this.cancel();
    return this.attach('thread/fork', { threadId: request.sessionId, deferGoalContinuation: true });
  }

  private async attach(method: string, params: JsonObject): Promise<{ sessionId: string }> {
    this.hydrating = true;
    try {
      const response = await this.request(method, params);
      const thread = object(response.thread);
      const id = string(thread.id);
      if (!id || (method === 'thread/fork' && id === params.threadId) || (method === 'thread/resume' && id !== params.threadId)) throw new PaneError('CHAT_IDENTITY_MISMATCH', 'Codex returned a different conversation than requested.', 'Keep the tab stopped and inspect its saved identity.');
      this.threadId = id;
      this.options.onIdentity?.(id);
      this.settings = response;
      // New servers may return only the newest history window. Read the older
      // pages without sending any historical request as a new model turn.
      const backwardsCursor = decodeOptionalBoundary(response.itemsBackwardsCursor, boundary.string);
      if (backwardsCursor) {
        let cursor: string | null = backwardsCursor;
        const pages: JsonObject[][] = [];
        const seen = new Set<string>();
        while (cursor) {
          if (seen.has(cursor)) throw new Error('Codex repeated its history cursor');
          seen.add(cursor);
          const page = await this.request('thread/items/list', { threadId: id, cursor, sortDirection: 'desc', limit: 100 });
          pages.push(array(page.data).map(object));
          cursor = decodeOptionalBoundary(page.nextCursor, boundary.string) ?? null;
        }
        for (const page of pages.reverse()) for (const entry of page.reverse()) this.item(object(entry.item));
      }
      for (const value of array(thread.turns ?? [])) this.hydrateTurn(object(value));
      this.loaded = true;
      return { sessionId: id };
    } finally {
      this.hydrating = false;
      for (const event of this.buffered.splice(0)) this.notification(event.method, event.params);
      this.options.onState?.();
    }
  }

  private hydrateTurn(turn: JsonObject): void {
    if (turn.status === 'inProgress') this.turnId = string(turn.id);
    for (const item of array(turn.items ?? [])) this.item(object(item));
  }

  private item(item: JsonObject): void {
    const id = string(item.id);
    let role: AgentChatMessage['role'] = 'assistant';
    let parts: AgentChatPart[];
    if (item.type === 'userMessage') {
      role = 'user';
      parts = array(item.content).map(value => { const content = object(value); return content.type === 'text' ? { type: 'text', text: string(content.text) } : { type: 'content', content }; });
    } else if (item.type === 'agentMessage' || item.type === 'plan') parts = [{ type: 'text', text: string(item.text) }];
    else if (item.type === 'reasoning') parts = [{ type: 'thought', text: [...array(item.summary ?? []), ...array(item.content ?? [])].map(string).join('\n') }];
    else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(string(item.type))) {
      parts = [{ type: 'tool', id, title: decodeOptionalBoundary(item.command, boundary.string) ?? decodeOptionalBoundary(item.tool, boundary.string) ?? 'File changes', status: item.status === 'completed' ? 'completed' : item.status === 'failed' || item.status === 'declined' ? 'failed' : 'in_progress', input: item.arguments ?? item.changes ?? item.command ?? null, output: item.aggregatedOutput ?? item.result ?? item.contentItems ?? null }];
    } else parts = [{ type: 'content', content: item }];
    this.options.onChange?.({ type: 'replace', message: { id, role, parts } });
  }

  private notification(method: string, params: JsonObject): void {
    if (params.threadId !== this.threadId) return;
    if (method === 'item/started' || method === 'item/completed') this.item(object(params.item));
    else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') this.options.onChange?.({ type: 'append', id: string(params.itemId), role: 'assistant', part: { type: method === 'item/agentMessage/delta' ? 'text' : 'thought', text: string(params.delta) } });
    else if (method === 'turn/started') this.turnId = string(object(params.turn).id);
    else if (method === 'turn/completed') {
      const turn = object(params.turn); const id = string(turn.id);
      this.completed.set(id, turn);
      if (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
      if (this.turnId === id) { this.turnId = undefined; this.finishTurn(turn); }
      this.approvals.clear(); this.unhandledInteraction = undefined;
    } else if (method === 'serverRequest/resolved') {
      this.approvals.delete(`${this.generation}:${JSON.stringify(params.requestId)}`);
      if (params.requestId === this.unhandledInteraction?.id) this.unhandledInteraction = undefined;
    }
    else if (method === 'thread/settings/updated') {
      const settings = object(params.threadSettings);
      this.settings = { ...this.settings, ...settings, reasoningEffort: settings.effort ?? null, sandbox: settings.sandboxPolicy ?? null };
    }
    this.options.onState?.();
  }

  private finishTurn(turn: JsonObject): void {
    if (turn.status === 'failed') this.turnResult?.reject(new PaneError('CHAT_CODEX_TURN_FAILED', decodeOptionalBoundary(turn.error, boundary.object({ message: boundary.string }))?.message ?? 'Codex could not finish this turn.', 'Inspect its response before sending a new request.'));
    else this.turnResult?.resolve({ stopReason: turn.status === 'interrupted' ? 'cancelled' : 'end_turn' });
    this.turnResult = undefined;
  }

  private serverRequest(wireId: string | number, method: string, params: JsonObject): void {
    if (params.threadId !== this.threadId) return;
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
      // Another native client may answer this request. Returning a synthetic
      // rejection here would consume it before that user could respond.
      this.unhandledInteraction = { id: wireId, message: 'Codex is waiting for an interaction that Chat cannot display. Open Terminal to inspect it, or cancel this turn.' };
      this.options.onState?.();
      return;
    }
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel'];
    const id = `${this.generation}:${JSON.stringify(wireId)}`;
    const answers = new Map<string, JsonValue>();
    const options = decisions.map((decision, index) => {
      const optionId = `${index}`; answers.set(optionId, { decision });
      const name = decision === 'accept' ? 'Allow once' : decision === 'acceptForSession' ? 'Allow for session' : decision === 'decline' ? 'Reject' : decision === 'cancel' ? 'Cancel turn' : JSON.stringify(decision);
      return { optionId, name, kind: decision === 'accept' ? 'allow_once' : decision === 'acceptForSession' ? 'allow_always' : 'reject_once' };
    });
    const title = decodeOptionalBoundary(params.command, boundary.string) ?? decodeOptionalBoundary(params.reason, boundary.string) ?? 'Allow file changes?';
    this.approvals.set(id, { wireId, answers, permission: { id, generation: this.generation, title, toolCall: { ...params, toolCallId: params.itemId }, options } });
    this.options.onState?.();
  }

  error(): string | undefined { return this.unhandledInteraction?.message; }

  permissions(): AgentChatPermission[] { return structuredClone([...this.approvals.values()].map(entry => entry.permission)); }
  answer(id: string, generation: number, optionId: string): void {
    if (generation !== this.generation) throw new PaneError('CHAT_STALE_GENERATION', 'The Codex connection changed. No answer was sent.', 'Refresh the conversation.');
    const approval = this.approvals.get(id); const answer = approval?.answers.get(optionId);
    if (!approval || !answer) throw new PaneError('CHAT_PERMISSION_ALREADY_ANSWERED', 'The requested permission or choice is no longer available.', 'Refresh the pending requests.');
    this.socket.send(JSON.stringify({ id: approval.wireId, result: answer }));
    this.approvals.delete(id); this.options.onState?.();
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    if (!this.loaded || !this.threadId) throw new PaneError('CHAT_NOT_LOADED', 'Codex has no verified conversation.', 'Recover its saved conversation first.');
    if (this.isRunning()) throw new PaneError('CHAT_TURN_RUNNING', 'Codex is already working. No new turn started.', 'Cancel the current turn or wait for its response.');
    const input = content.map((part): JsonObject => {
      if (part.type === 'text') return { type: 'text', text: part.text, text_elements: [] };
      if (part.type === 'image') return { type: 'image', url: `data:${part.mimeType};base64,${part.data}` };
      throw new PaneError('CHAT_CONTENT_UNSUPPORTED', 'Codex cannot send this attachment type.', 'Use text or an image.');
    });
    const result = new Promise<PromptResponse>((resolve, reject) => { this.turnResult = { resolve, reject }; });
    this.options.onState?.();
    try {
      const response = await this.request('turn/start', { threadId: this.threadId, input });
      const turn = object(response.turn); const id = string(turn.id);
      const completed = this.completed.get(id);
      if (completed || turn.status !== 'inProgress') this.finishTurn(completed ?? turn);
      else this.turnId = id;
    } catch (error) { this.turnResult?.reject(error instanceof Error ? error : new Error(String(error))); this.turnResult = undefined; }
    return result;
  }

  isRunning(): boolean { return !!this.turnId || !!this.turnResult || this.configuring; }
  supportsImages(): boolean { return true; }
  config(): JsonObject { return structuredClone(this.settings); }
  controls(): AgentChatConfigOption[] {
    const model = decodeOptionalBoundary(this.settings.model, boundary.string) ?? '';
    const selected = this.models.find(entry => entry.model === model);
    const efforts = selected && Array.isArray(selected.supportedReasoningEfforts) ? selected.supportedReasoningEfforts.map(object) : [];
    return [
      { id: 'model', name: 'Model', currentValue: model, options: this.models.map(entry => ({ value: string(entry.model), name: string(entry.displayName ?? entry.model) })) },
      { id: 'effort', name: 'Effort', currentValue: decodeOptionalBoundary(this.settings.reasoningEffort, boundary.string) ?? '', options: efforts.map(entry => ({ value: string(entry.reasoningEffort), name: string(entry.reasoningEffort) })) },
    ].filter(option => option.options.length > 0);
  }

  async configure(id: string, value: string): Promise<void> {
    if (this.isRunning() || this.approvals.size || !this.threadId) throw new PaneError('CHAT_CONFIG_BUSY', 'Codex settings cannot change during this turn.', 'Wait for the turn or cancel it.');
    if (!this.controls().find(option => option.id === id)?.options.some(option => option.value === value)) throw new PaneError('CHAT_CONFIG_UNSUPPORTED', 'Codex did not advertise that setting.', 'Select a current option.');
    this.configuring = true; this.options.onState?.();
    try {
      await this.request('thread/settings/update', { threadId: this.threadId, [id]: value });
      const response = await this.request('thread/resume', { threadId: this.threadId });
      this.settings = response;
      if (response[id === 'effort' ? 'reasoningEffort' : id] !== value) throw new PaneError('CHAT_CONFIG_UNCONFIRMED', 'Codex did not confirm the setting.', 'Refresh before continuing.');
    } finally { this.configuring = false; this.options.onState?.(); }
  }

  async cancel(): Promise<void> {
    const startingDeadline = Date.now() + (this.options.requestTimeoutMs ?? 30_000);
    while (this.turnResult && !this.turnId && Date.now() < startingDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (this.turnResult && !this.turnId) throw new PaneError('CHAT_CANCEL_UNCONFIRMED', 'Codex has not identified the starting turn, so its cancellation is unconfirmed.', 'Inspect the current turn before retrying.');
    if (!this.turnId || !this.threadId) return;
    const turnId = this.turnId;
    await this.request('turn/interrupt', { threadId: this.threadId, turnId });
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 30_000);
    while (this.turnId === turnId && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (this.turnId === turnId) throw new PaneError('CHAT_CANCEL_UNCONFIRMED', 'Codex did not confirm that the turn stopped.', 'Leave the conversation stopped and inspect its native runtime.');
  }

  async close(): Promise<void> { this.closing = true; this.socket.close(); }
}
