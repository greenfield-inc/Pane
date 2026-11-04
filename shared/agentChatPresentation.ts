import { boundary, decodeOptionalBoundary, type JsonValue } from './validation/boundaryDecoder';
import type { AgentChatMessage, AgentChatPermission } from './types/agentChat';

export type ChatDisplayPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; image: string }
  | { type: 'data'; name: string; data: JsonValue }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, JsonValue>; result?: JsonValue; isPreliminary: boolean; isError: boolean };

export interface ChatDisplayMessage { id: string; role: 'user' | 'assistant'; content: ChatDisplayPart[] }

/** A selectable fallback for provider content without a dedicated renderer. */
export function describeChatContent(data: JsonValue) {
  const content = decodeOptionalBoundary(data, boundary.object({
    type: boundary.optional(boundary.string), name: boundary.optional(boundary.string), title: boundary.optional(boundary.string), uri: boundary.optional(boundary.string),
    resource: boundary.optional(boundary.object({ uri: boundary.optional(boundary.string), text: boundary.optional(boundary.string) })),
  }));
  const uri = content?.uri ?? content?.resource?.uri;
  const name = content?.title ?? content?.name;
  const resource = content?.type === 'resource' || content?.type === 'resource_link';
  return { label: resource ? name ? `Resource: ${name}` : 'Resource content' : content?.type ? `Content: ${content.type}` : 'Agent content', uri, text: content?.resource?.text, details: JSON.stringify(data, null, 2) };
}

export function permissionToolId(permission: AgentChatPermission): string | undefined {
  return decodeOptionalBoundary(permission.toolCall, boundary.object({ toolCallId: boundary.string }))?.toolCallId;
}

/** Presentation only: provider tools execute exclusively on the owning host. */
export function toAssistantMessage(message: AgentChatMessage): ChatDisplayMessage {
  const content: ChatDisplayPart[] = message.parts.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'thought') return { type: 'reasoning', text: part.text };
    if (part.type === 'tool') return {
      type: 'tool-call', toolCallId: part.id, toolName: part.title,
      args: { input: part.input ?? null, status: part.status },
      result: part.status === 'completed' || part.status === 'failed' || part.content
        ? { output: part.output ?? null, content: part.content ?? [] } : undefined,
      isPreliminary: part.status === 'pending' || part.status === 'in_progress',
      isError: part.status === 'failed',
    };
    if (part.type === 'content') {
      const data = part.content;
      const image = decodeOptionalBoundary(data, boundary.object({ type: boundary.literal('image'), data: boundary.string, mimeType: boundary.enumeration('image/png', 'image/jpeg', 'image/webp', 'image/gif') }));
      if (image) {
        return { type: 'image', image: `data:${image.mimeType};base64,${image.data}` };
      }
      return { type: 'data', name: 'acp', data };
    }
    return { type: 'text', text: '' };
  });
  return { id: message.id, role: message.role, content };
}
