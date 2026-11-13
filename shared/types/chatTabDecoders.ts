import { boundary, decodeBoundary, type BoundarySchema } from '../validation/boundaryDecoder';
import type { AgentChatMessage, AgentChatPart, AgentChatReceipt } from './agentChat';
import type { ChatAgentEntry, ChatTabConversation, ChatTabEvent, ChatTabProblem, ChatTabQuestion, ChatTabQueuedPrompt, ChatTabSwitchBanner, ChatTabView, ChatToolPatch } from './chatTab';

const status = boundary.enumeration('pending', 'in_progress', 'completed', 'failed');
const part: BoundarySchema<AgentChatPart> = boundary.union(
  boundary.object({ type: boundary.enumeration('text', 'thought'), text: boundary.string }),
  boundary.object({
    type: boundary.literal('tool'), id: boundary.string, title: boundary.string, status,
    input: boundary.optional(boundary.json), output: boundary.optional(boundary.json), content: boundary.optional(boundary.array(boundary.json)),
    kind: boundary.optional(boundary.string), locations: boundary.optional(boundary.json), terminal: boundary.optional(boundary.string),
    approvedBy: boundary.optional(boundary.literal('pane')),
  }),
  boundary.object({ type: boundary.literal('content'), content: boundary.json }),
);
export const chatMessageSchema: BoundarySchema<AgentChatMessage> = boundary.object({ id: boundary.string, role: boundary.enumeration('user', 'assistant'), parts: boundary.array(part) });
const patch: BoundarySchema<ChatToolPatch> = boundary.object({
  title: boundary.optional(boundary.string), status: boundary.optional(status),
  input: boundary.optional(boundary.json), output: boundary.optional(boundary.json), content: boundary.optional(boundary.array(boundary.json)),
  kind: boundary.optional(boundary.string), locations: boundary.optional(boundary.json), terminal: boundary.optional(boundary.string),
  terminalAppend: boundary.optional(boundary.string), approvedBy: boundary.optional(boundary.literal('pane')),
});
const event: BoundarySchema<ChatTabEvent> = boundary.object({
  panelId: boundary.string, generation: boundary.number, revision: boundary.number, index: boundary.number,
  change: boundary.union(
    boundary.object({ type: boundary.literal('append'), id: boundary.string, role: boundary.enumeration('user', 'assistant'), part }),
    boundary.object({ type: boundary.literal('replace'), message: chatMessageSchema }),
    boundary.object({ type: boundary.literal('tool'), id: boundary.string, patch }),
  ),
});
const problem: BoundarySchema<ChatTabProblem> = boundary.object({
  code: boundary.enumeration('signed-out', 'not-installed', 'adapter-setup', 'exited', 'failed', 'unsupported-host'),
  message: boundary.string, next: boundary.string,
  action: boundary.optional(boundary.enumeration('sign-in', 'install', 'restart')), url: boundary.optional(boundary.string),
});
const image = boundary.object({ mimeType: boundary.string, data: boundary.string });
const queued: BoundarySchema<ChatTabQueuedPrompt> = boundary.object({ operationId: boundary.string, text: boundary.string, images: boundary.optional(boundary.array(image)), queuedAt: boundary.string, stored: boundary.optional(boundary.literal(true)), imageCount: boundary.optional(boundary.number) });
const question: BoundarySchema<ChatTabQuestion> = boundary.object({ id: boundary.string, generation: boundary.number, message: boundary.string, schema: boundary.json, toolCallId: boundary.optional(boundary.string) });
const banner: BoundarySchema<ChatTabSwitchBanner> = boundary.union(
  boundary.object({ kind: boundary.enumeration('most-recent', 'none', 'known-empty') }),
  boundary.object({ kind: boundary.literal('list-failed'), reason: boundary.string }),
);
const conversation: BoundarySchema<ChatTabConversation> = boundary.object({
  sessionId: boundary.string, title: boundary.optional(boundary.string), updatedAt: boundary.optional(boundary.string),
  current: boundary.optional(boundary.literal(true)), openIn: boundary.optional(boundary.object({ panelId: boundary.string, title: boundary.string })),
});
const view: BoundarySchema<ChatTabView> = boundary.object({
  panelId: boundary.string, agent: boundary.string, generation: boundary.number,
  status: boundary.enumeration('starting', 'idle', 'working', 'blocked', 'stopped'),
  problem: boundary.optional(problem), notice: boundary.optional(boundary.string), canAttachImages: boundary.boolean,
  controls: boundary.array(boundary.object({ id: boundary.string, name: boundary.string, category: boundary.optional(boundary.string), currentValue: boundary.string, options: boundary.array(boundary.object({ value: boundary.string, name: boundary.string })) })),
  commands: boundary.array(boundary.object({ name: boundary.string, description: boundary.optional(boundary.string), hint: boundary.optional(boundary.string) })),
  permissions: boundary.array(boundary.object({ id: boundary.string, generation: boundary.number, title: boundary.string, toolCall: boundary.json, options: boundary.array(boundary.object({ optionId: boundary.string, name: boundary.string, kind: boundary.string })) })),
  questions: boundary.array(question),
  queue: boundary.array(queued),
  transcript: boundary.optional(boundary.object({ panelId: boundary.string, generation: boundary.number, revision: boundary.number, start: boundary.number, messages: boundary.array(chatMessageSchema) })),
  messageCount: boundary.number,
  context: boundary.optional(boundary.object({ used: boundary.number, size: boundary.number })),
  tasks: boundary.optional(boundary.array(boundary.object({ id: boundary.string, kind: boundary.string, title: boundary.optional(boundary.string), startedAt: boundary.string, canStop: boundary.optional(boundary.literal(false)) }))),
  clearedAt: boundary.optional(boundary.string),
  banner: boundary.optional(banner),
});
const receipt: BoundarySchema<AgentChatReceipt> = boundary.object({
  operationId: boundary.string, generation: boundary.number, fingerprint: boundary.string,
  state: boundary.enumeration('accepted', 'completed', 'failed'), error: boundary.optional(boundary.string),
});

const agentEntry: BoundarySchema<ChatAgentEntry> = boundary.object({
  id: boundary.string, label: boundary.string, icon: boundary.string, iconUrl: boundary.optional(boundary.string), description: boundary.optional(boundary.string),
  source: boundary.enumeration('config', 'registry'), installed: boundary.boolean, version: boundary.optional(boundary.string),
  capabilities: boundary.optional(boundary.object({ reopen: boundary.boolean, list: boundary.boolean, images: boundary.boolean })),
  fullAccess: boundary.enumeration('agent', 'pane'),
  switchFromTerminal: boundary.union(boundary.object({ ok: boundary.literal(true) }), boundary.object({ ok: boundary.literal(false), reason: boundary.string })),
  installUrl: boundary.optional(boundary.string),
});

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Remote chat tab data is decoded immediately with the agent schema.
export function decodeChatAgents(value: unknown): ChatAgentEntry[] { return decodeBoundary(value, boundary.array(agentEntry)); }
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Remote chat tab data is decoded immediately with the view schema.
export function decodeChatTabView(value: unknown): ChatTabView { return decodeBoundary(value, view); }
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Remote chat tab data is decoded immediately with the event schema.
export function decodeChatTabEvent(value: unknown): ChatTabEvent { return decodeBoundary(value, event); }
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Remote chat tab data is decoded immediately with the message schema.
export function decodeChatMessages(value: unknown): AgentChatMessage[] { return decodeBoundary(value, boundary.array(chatMessageSchema)); }
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Remote chat tab data is decoded immediately with the conversation schema.
export function decodeChatConversations(value: unknown): ChatTabConversation[] { return decodeBoundary(value, boundary.array(conversation)); }
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Remote chat tab data is decoded immediately with the receipt schema.
export function decodeChatReceipt(value: unknown): AgentChatReceipt | undefined { return value === undefined || value === null ? undefined : decodeBoundary(value, receipt); }
