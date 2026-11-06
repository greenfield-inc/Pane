import { appendFileSync, closeSync, mkdirSync, openSync, readSync, rmSync, truncateSync } from 'fs';
import path from 'path';
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { CHAT_TERMINAL_LIMIT } from '../../../../shared/types/chatTab';

const terminalMeta = boundary.object({ terminal_output_delta: boundary.optional(boundary.string), terminal_output: boundary.optional(boundary.string) });
import type { AgentChatMessage, AgentChatPart } from '../../../../shared/types/agentChat';
import { chatMessageSchema } from '../../../../shared/types/chatTabDecoders';
import { patchTool, type ChatTabChange, type ChatTabEvent, type ChatTabTranscript, type ChatToolPatch } from '../../../../shared/types/chatTab';

export interface ChatTranscriptOptions {
  /** Where messages that leave the memory window are kept for paging. */
  spoolFile: string;
  windowMessages?: number;
  windowBytes?: number;
}

/** Marks the end of a live turn, for the folded turn line (duration and how it ended). */
export interface TurnMarker { type: 'pane_turn'; stopReason: string; startedAt: string; endedAt: string }

/**
 * The ACP-to-view mapping for one chat tab generation. There is no cap that
 * stops a conversation: the newest messages stay in memory, and older ones are
 * written to a per-tab file and paged in when a viewer scrolls back. The agent's
 * own session store stays authoritative; this file is rebuilt at every start.
 */
export class ChatTranscript {
  private revision = 0;
  /** Global index of `resident[0]`. */
  private base = 0;
  private readonly residentMessages: AgentChatMessage[] = [];
  private readonly residentSizes: number[] = [];
  private residentBytes = 0;
  private readonly offsets: Array<{ at: number; length: number }> = [];
  private spoolBytes = 0;
  /** The spool file could not be repaired after a failed write; messages stay in memory until the next start. */
  private spoolBroken = false;
  private readonly indexes = new Map<string, number>();
  private chunk?: { id: string; role: AgentChatMessage['role']; agentId?: string };
  private echo?: { text: string; received: string };
  private sequence = 0;
  private readonly windowMessages: number;
  private readonly windowBytes: number;

  constructor(readonly panelId: string, readonly generation: number, private readonly options: ChatTranscriptOptions) {
    this.windowMessages = options.windowMessages ?? 1000;
    this.windowBytes = options.windowBytes ?? 24 * 1024 * 1024;
    mkdirSync(path.dirname(options.spoolFile), { recursive: true, mode: 0o700 });
    rmSync(options.spoolFile, { force: true });
  }

  count(): number { return this.base + this.residentMessages.length; }
  resident(): number { return this.residentMessages.length; }
  /** Estimated bytes of the messages held in memory. */
  residentSize(): number { return this.residentBytes; }
  currentRevision(): number { return this.revision; }

  snapshot(limit: number): ChatTabTranscript {
    const count = Math.min(limit, this.residentMessages.length);
    const messages = this.residentMessages.slice(this.residentMessages.length - count);
    return { panelId: this.panelId, generation: this.generation, revision: this.revision, start: this.count() - count, messages: structuredClone(messages) };
  }

  /** Messages in [before - limit, before), oldest first. */
  history(before: number, limit: number): AgentChatMessage[] {
    const end = Math.max(0, Math.min(before, this.count()));
    const start = Math.max(0, end - Math.max(0, limit));
    const result: AgentChatMessage[] = [];
    const spooled = Math.min(end, this.base);
    if (start < spooled) result.push(...this.readSpool(start, spooled));
    for (let index = Math.max(start, this.base); index < end; index++) result.push(structuredClone(this.residentMessages[index - this.base]));
    return result;
  }

  /** Every message's text, for runpane screen/output. Reads spooled messages one page at a time. */
  *all(): Generator<AgentChatMessage> {
    for (let start = 0; start < this.base; start += 200) yield* this.readSpool(start, Math.min(this.base, start + 200));
    yield* this.residentMessages;
  }

  /** The newest message of a role, without copying the conversation. */
  last(role: AgentChatMessage['role'], accept: (message: AgentChatMessage) => boolean = () => true): AgentChatMessage | undefined {
    for (let index = this.residentMessages.length - 1; index >= 0; index--) {
      const message = this.residentMessages[index];
      if (message.role === role && accept(message)) return structuredClone(message);
    }
    return undefined;
  }

  endTurn(marker?: TurnMarker): ChatTabEvent | undefined {
    this.chunk = undefined;
    this.echo = undefined;
    if (!marker) return undefined;
    return this.commit({ type: 'replace', message: { id: `turn:${++this.sequence}`, role: 'assistant', parts: [{ type: 'content', content: { ...marker } }] } });
  }

  /** The prompt as Pane sent it. An echo of the same text from the agent is folded into it. */
  userMessage(operationId: string, content: ContentBlock[]): ChatTabEvent[] {
    this.chunk = undefined;
    this.sequence++; // The next to-do list is this prompt's own.
    const events: ChatTabEvent[] = [];
    const id = `user:${operationId}`;
    for (const block of content) {
      const part: AgentChatPart = block.type === 'text' ? { type: 'text', text: block.text } : { type: 'content', content: decodeBoundary(block, boundary.json) };
      const event = this.commit({ type: 'append', id, role: 'user', part });
      if (event) events.push(event);
    }
    this.echo = { text: content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''), received: '' };
    return events;
  }

  accept(update: SessionUpdate): ChatTabEvent | undefined {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
        if (role === 'user' && this.echo && update.content.type === 'text') {
          const received = this.echo.received + update.content.text;
          if (this.echo.text.startsWith(received)) { this.echo.received = received; return undefined; }
        }
        if (role === 'assistant') this.echo = undefined;
        const id = this.chunkId(role, update.messageId ?? undefined);
        const part: AgentChatPart = update.content.type === 'text'
          ? { type: update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'text', text: update.content.text }
          : { type: 'content', content: decodeBoundary(update.content, boundary.json) };
        return this.commit({ type: 'append', id, role, part });
      }
      case 'tool_call': {
        this.chunk = undefined;
        const id = `tool:${update.toolCallId}`;
        const part: Extract<AgentChatPart, { type: 'tool' }> = { type: 'tool', id: update.toolCallId, title: update.title, status: update.status ?? 'pending' };
        if (update.kind) part.kind = update.kind;
        if (update.rawInput !== undefined) part.input = decodeBoundary(update.rawInput, boundary.json);
        if (update.rawOutput !== undefined) part.output = decodeBoundary(update.rawOutput, boundary.json);
        if (update.content?.length) part.content = decodeBoundary(update.content, boundary.array(boundary.json));
        if (update.locations?.length) part.locations = decodeBoundary(update.locations, boundary.json);
        return this.commit({ type: 'replace', message: { id, role: 'assistant', parts: [part] } });
      }
      case 'tool_call_update': {
        this.chunk = undefined;
        const id = `tool:${update.toolCallId}`;
        const patch: ChatToolPatch = {};
        if (update.title != null) patch.title = update.title;
        if (update.status != null) patch.status = update.status;
        if (update.kind != null) patch.kind = update.kind;
        if (update.rawInput !== undefined) patch.input = decodeBoundary(update.rawInput, boundary.json);
        if (update.rawOutput !== undefined) patch.output = decodeBoundary(update.rawOutput, boundary.json);
        if (update.content != null) patch.content = decodeBoundary(update.content, boundary.array(boundary.json));
        if (update.locations != null) patch.locations = decodeBoundary(update.locations, boundary.json);
        // claude-agent-acp's terminal extension: live command output for the step's own row.
        const terminal = decodeOptionalBoundary(update._meta, terminalMeta);
        if (terminal?.terminal_output_delta) patch.terminalAppend = terminal.terminal_output_delta;
        else if (terminal?.terminal_output !== undefined) patch.terminal = terminal.terminal_output.slice(-CHAT_TERMINAL_LIMIT);
        if (!this.indexes.has(id)) {
          return this.commit({ type: 'replace', message: { id, role: 'assistant', parts: [{ type: 'tool', id: update.toolCallId, title: patch.title ?? 'Tool', status: patch.status ?? 'pending', ...patch }] } });
        }
        return this.commit({ type: 'tool', id, patch });
      }
      case 'plan': {
        // One todo list per turn: each update replaces it.
        const id = `plan:${this.sequence}`;
        return this.commit({ type: 'replace', message: { id, role: 'assistant', parts: [{ type: 'content', content: decodeBoundary({ type: 'plan', entries: update.entries }, boundary.json) }] } });
      }
      case 'available_commands_update':
      case 'config_option_update':
      case 'current_mode_update':
      case 'usage_update':
      case 'session_info_update':
        return undefined;
      default:
        this.chunk = undefined;
        // Unknown or extension updates render as a plain row rather than breaking the tab.
        return this.commit({ type: 'replace', message: { id: `update:${this.generation}:${++this.sequence}`, role: 'assistant', parts: [{ type: 'content', content: decodeBoundary(update, boundary.json) }] } });
    }
  }

  /**
   * The row a chunk belongs to. Chunks of the message being written join it. A message
   * the agent returns to after a step gets a new row below that step: Claude's id is
   * its API message's, which spans text and steps, and rows stay in the order things happened.
   */
  private chunkId(role: AgentChatMessage['role'], agentId: string | undefined): string {
    if (this.chunk?.role === role && this.chunk.agentId === agentId) return this.chunk.id;
    if (role === 'user') this.sequence++; // A replayed prompt starts a turn: the next to-do list is its own.
    const id = agentId && !this.indexes.has(agentId) ? agentId : `${role}:${this.generation}:${++this.sequence}`;
    this.chunk = { id, role, agentId };
    return id;
  }

  private commit(change: ChatTabChange): ChatTabEvent | undefined {
    const id = change.type === 'replace' ? change.message.id : change.id;
    let index = this.indexes.get(id);
    if (index !== undefined && index < this.base) return undefined; // Already paged out; the agent's store keeps it.
    let message: AgentChatMessage;
    if (index === undefined) {
      if (change.type === 'tool') return undefined;
      index = this.count();
      message = change.type === 'replace' ? structuredClone(change.message) : { id, role: change.role, parts: [structuredClone(change.part)] };
      this.indexes.set(id, index);
      this.residentMessages.push(message);
      this.residentSizes.push(0);
    } else {
      const local = index - this.base;
      message = this.residentMessages[local];
      if (change.type === 'replace') message = structuredClone(change.message);
      else if (change.type === 'append') {
        const last = message.parts.at(-1);
        if ((change.part.type === 'text' || change.part.type === 'thought') && last?.type === change.part.type) last.text += change.part.text;
        else message.parts.push(structuredClone(change.part));
      } else {
        const part = message.parts[0];
        if (part?.type === 'tool') patchTool(part, change.patch);
      }
      this.residentMessages[local] = message;
    }
    const local = index - this.base;
    const size = estimateSize(message);
    this.residentBytes += size - this.residentSizes[local];
    this.residentSizes[local] = size;
    this.revision++;
    const event: ChatTabEvent = { panelId: this.panelId, generation: this.generation, revision: this.revision, index, change: structuredClone(change) };
    this.evict();
    return event;
  }

  private evict(): void {
    // Keep at least the newest message resident, so a streaming reply is never paged out mid-turn.
    while (!this.spoolBroken && this.residentMessages.length > 1 && (this.residentMessages.length > this.windowMessages || this.residentBytes > this.windowBytes)) {
      const line = `${JSON.stringify(this.residentMessages[0])}\n`;
      const length = Buffer.byteLength(line);
      // Written before it leaves memory: a failed write keeps the message resident and the indexes unchanged.
      try { appendFileSync(this.options.spoolFile, line, { mode: 0o600 }); }
      catch (error) { this.spoolFailed(error instanceof Error ? error.message : String(error)); return; }
      this.residentMessages.shift();
      this.residentBytes -= this.residentSizes.shift()!;
      this.offsets.push({ at: this.spoolBytes, length });
      this.spoolBytes += length;
      this.base++;
    }
  }

  /** Cuts a partly written line off, then tries again on the next eviction; holds everything in memory if even that fails. */
  private spoolFailed(reason: string): void {
    console.warn(`[ChatTabs] Older messages of ${this.panelId} could not be written to disk; they stay in memory: ${reason}`);
    try { truncateSync(this.options.spoolFile, this.spoolBytes); }
    catch { this.spoolBroken = true; }
  }

  private readSpool(start: number, end: number): AgentChatMessage[] {
    if (start >= end) return [];
    const first = this.offsets[start];
    const last = this.offsets[end - 1];
    const buffer = Buffer.alloc(last.at + last.length - first.at);
    const descriptor = openSync(this.options.spoolFile, 'r');
    try { readSync(descriptor, buffer, 0, buffer.length, first.at); } finally { closeSync(descriptor); }
    return buffer.toString('utf8').split('\n').filter(Boolean).map(line => decodeBoundary(JSON.parse(line), chatMessageSchema));
  }

  dispose(): void { rmSync(this.options.spoolFile, { force: true }); }
}

function estimateSize(message: AgentChatMessage): number {
  let size = 64;
  for (const part of message.parts) size += part.type === 'text' || part.type === 'thought' ? part.text.length * 2 : JSON.stringify(part).length * 2;
  return size;
}
