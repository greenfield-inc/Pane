import { PaneError } from '../../../../shared/paneError';
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { type AgentChatEvent, type AgentChatMessage, type AgentChatPart, type AgentChatTranscript } from '../../../../shared/types/agentChat';

/** The single ACP-to-view mapping. The provider store remains authoritative. */
export class TranscriptProjection {
  private state: AgentChatTranscript;
  private readonly indexes = new Map<string, number>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;
  private overflow = false;
  private chunkId: string | undefined;
  private chunkRole: AgentChatMessage['role'] | undefined;

  constructor(panelId: string, generation: number, private readonly limits = { maxBytes: 16 * 1024 * 1024, maxMessages: 4000 }) {
    this.state = { panelId, generation, revision: 0, messages: [] };
  }

  snapshot(): AgentChatTranscript {
    return structuredClone(this.state);
  }

  setGeneration(generation: number): void { this.state = { ...this.state, generation, revision: 0 }; }

  error(): string | undefined { return this.overflow ? 'The conversation exceeds the Chat display limit (4,000 messages or 16 MiB). The provider retains its full history. Use Terminal to inspect the complete conversation.' : undefined; }

  assertComplete(): void {
    if (this.overflow) throw new PaneError('CHAT_HISTORY_TOO_LARGE', this.error()!, 'Continue in Terminal; Chat did not activate with an incomplete history.');
  }

  endTurn(): void {
    this.chunkId = undefined;
    this.chunkRole = undefined;
  }

  accept(update: SessionUpdate): AgentChatEvent {
    const revision = this.state.revision + 1;
    let change: AgentChatEvent['change'];
    if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
      const id = update.messageId ?? (this.chunkRole === role ? this.chunkId : undefined) ?? `${this.state.generation}:${revision}`;
      this.chunkId = id;
      this.chunkRole = role;
      const part: AgentChatPart = update.content.type === 'text'
        ? { type: update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'text', text: update.content.text }
        : { type: 'content', content: decodeBoundary(update.content, boundary.json) };
      change = { type: 'append', id, role, part };
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.endTurn();
      const id = `tool:${update.toolCallId}`;
      const previousIndex = this.indexes.get(id);
      const previous = previousIndex === undefined ? undefined : this.state.messages[previousIndex];
      const message: AgentChatMessage = previous ? structuredClone(previous) : { id, role: 'assistant', parts: [{ type: 'tool', id: update.toolCallId, title: update.title ?? 'Tool activity', status: update.status ?? 'pending' }] };
      const part = message.parts[0];
      if (part?.type !== 'tool') throw new Error('Invalid tool projection');
      if (update.title != null) part.title = update.title;
      if (update.status != null) part.status = update.status;
      if (update.rawInput !== undefined) part.input = decodeBoundary(update.rawInput, boundary.json);
      if (update.rawOutput !== undefined) part.output = decodeBoundary(update.rawOutput, boundary.json);
      if (update.content != null) part.content = decodeBoundary(update.content, boundary.array(boundary.json));
      change = { type: 'replace', message };
    } else {
      // Preserve protocol extensions and metadata for a generic renderer.
      change = { type: 'replace', message: { id: `update:${update.sessionUpdate}`, role: 'assistant', parts: [{ type: 'content', content: decodeBoundary(update, boundary.json) }] } };
    }
    return this.acceptChange(change);
  }

  /** Provider messages share the same bounded, revisioned viewer contract. */
  acceptChange(change: AgentChatEvent['change']): AgentChatEvent {
    const event: AgentChatEvent = { panelId: this.state.panelId, generation: this.state.generation, revision: this.state.revision + 1, change };
    if (this.overflow) return event;
    const id = change.type === 'replace' ? change.message.id : change.id;
    const index = this.indexes.get(id);
    const previous = index === undefined ? undefined : this.state.messages[index];
    const message = change.type === 'replace' ? change.message : previous ? structuredClone(previous) : { id, role: change.role, parts: [] };
    if (change.type === 'append') {
      const last = message.parts.at(-1);
      if ((change.part.type === 'text' || change.part.type === 'thought') && last?.type === change.part.type) last.text += change.part.text;
      else message.parts.push(structuredClone(change.part));
    }
    const size = Buffer.byteLength(JSON.stringify(message));
    const bytes = this.bytes - (this.sizes.get(id) ?? 0) + size;
    if (bytes > this.limits.maxBytes || (index === undefined && this.state.messages.length >= this.limits.maxMessages)) { this.overflow = true; return event; }
    if (index === undefined) { this.indexes.set(id, this.state.messages.length); this.state.messages.push(message); }
    else this.state.messages[index] = message;
    this.sizes.set(id, size);
    this.bytes = bytes;
    this.state.revision = event.revision;
    return event;
  }
}
