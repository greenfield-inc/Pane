import { boundary, decodeBoundary, type BoundarySchema } from '../validation/boundaryDecoder';
import type { AgentChatEvent, AgentChatMessage, AgentChatPart, AgentChatView, AgentConversationRecord } from './agentChat';

const part: BoundarySchema<AgentChatPart> = boundary.union(
  boundary.object({ type: boundary.enumeration('text', 'thought'), text: boundary.string }),
  boundary.object({ type: boundary.literal('tool'), id: boundary.string, title: boundary.string, status: boundary.enumeration('pending', 'in_progress', 'completed', 'failed'), input: boundary.optional(boundary.json), output: boundary.optional(boundary.json), content: boundary.optional(boundary.array(boundary.json)) }),
  boundary.object({ type: boundary.literal('content'), content: boundary.json }),
);
const message: BoundarySchema<AgentChatMessage> = boundary.object({ id: boundary.string, role: boundary.enumeration('user', 'assistant'), parts: boundary.array(part) });
const conversation: BoundarySchema<AgentConversationRecord> = boundary.object({
  panelId: boundary.string, workspaceId: boundary.string, provider: boundary.enumeration('claude', 'codex'), nativeSessionId: boundary.string,
  generation: boundary.number, active: boundary.enumeration('terminal', 'chat', 'stopped'), preferred: boundary.enumeration('terminal', 'chat'), recovery: boundary.optional(boundary.string),
  transferNotice: boundary.optional(boundary.string), forkUnconfirmed: boundary.optional(boundary.boolean),
  nativeStartup: boundary.optional(boundary.boolean),
  pendingSwitch: boundary.optional(boundary.object({ target: boundary.enumeration('terminal', 'chat'), reason: boundary.string })),
  transition: boundary.optional(boundary.object({ source: boundary.enumeration('terminal', 'chat'), target: boundary.enumeration('terminal', 'chat'), phase: boundary.enumeration('releasing', 'loading') })),
});
const event: BoundarySchema<AgentChatEvent> = boundary.object({
  panelId: boundary.string, generation: boundary.number, revision: boundary.number,
  change: boundary.union(
    boundary.object({ type: boundary.literal('append'), id: boundary.string, role: boundary.enumeration('user', 'assistant'), part }),
    boundary.object({ type: boundary.literal('replace'), message }),
  ),
});
const view: BoundarySchema<AgentChatView> = boundary.object({
  panelId: boundary.string, conversation: boundary.optional(conversation), available: boundary.boolean, unavailableReason: boundary.optional(boundary.string), setupRequired: boundary.boolean, running: boundary.boolean,
  controls: boundary.optional(boundary.array(boundary.object({ id: boundary.string, name: boundary.string, currentValue: boundary.string, options: boundary.array(boundary.object({ value: boundary.string, name: boundary.string })) }))),
  identificationRequired: boundary.optional(boundary.boolean),
  identificationSocketRequired: boundary.optional(boundary.boolean),
  canAttachImages: boundary.optional(boundary.boolean), error: boundary.optional(boundary.string), configuration: boundary.optional(boundary.json),
  permissions: boundary.array(boundary.object({ id: boundary.string, generation: boundary.number, title: boundary.string, toolCall: boundary.json, options: boundary.array(boundary.object({ optionId: boundary.string, name: boundary.string, kind: boundary.string })) })),
  transcript: boundary.optional(boundary.object({ panelId: boundary.string, generation: boundary.number, revision: boundary.number, messages: boundary.array(message) })),
});
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External agent chat data is decoded immediately with the view schema.
export function decodeAgentChatView(value: unknown): AgentChatView { return decodeBoundary(value, view); }
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External agent chat data is decoded immediately with the event schema.
export function decodeAgentChatEvent(value: unknown): AgentChatEvent { return decodeBoundary(value, event); }
