import type { AppendMessage, Attachment, AttachmentAdapter, CreateAttachment, ThreadMessageLike } from '@assistant-ui/react-native';

import { toAssistantMessage } from '@shared/agentChatPresentation';
import type { AgentChatMessage } from '@shared/types/agentChat';
import type { ChatTabSend } from '@shared/types/chatTab';

import { CHAT_IMAGE_TYPES, chatSendRequest, type ChatDraftImage } from './chatComposer';

/**
 * The bridge between the host transcript and assistant-ui's external-store runtime.
 * The host owns the conversation; the runtime only mirrors it and owns the composer
 * (text and attached images) until a message is confirmed.
 */

/** One host message as an assistant-ui thread message (the same conversion desktop uses). */
export function chatThreadMessage(message: AgentChatMessage): ThreadMessageLike {
  return toAssistantMessage(message);
}

/** A picked image as a ready composer attachment: no upload step, the bytes travel with the message. */
export function chatImageAttachment(image: ChatDraftImage): CreateAttachment {
  return {
    id: image.key,
    type: 'image',
    name: image.uri.split('/').pop() || 'image',
    contentType: image.mimeType,
    content: [{ type: 'image', image: `data:${image.mimeType};base64,${image.data}` }],
  };
}

/** The image a composer attachment shows as its thumbnail. */
export function attachmentPreview(attachment: Pick<Attachment, 'content'>): string | undefined {
  for (const part of attachment.content ?? []) if (part.type === 'image') return part.image;
  return undefined;
}

/**
 * The runtime's attachment adapter. React Native has no File: the photo picker adds
 * ready attachments (chatImageAttachment), so this only declares the accepted types,
 * which the runtime checks on every attachment added.
 */
export const chatImageAdapter: AttachmentAdapter = {
  accept: CHAT_IMAGE_TYPES.join(','),
  add: () => Promise.reject(new Error('Attach an image with the + button.')),
  remove: () => Promise.resolve(),
  send: () => Promise.reject(new Error('Attach an image with the + button.')),
};

type ComposedMessage = Pick<AppendMessage, 'content' | 'attachments'>;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s;

/** The text the composer sent, as one string. */
export function composedText(message: ComposedMessage): string {
  return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
}

/**
 * The host request for a message the composer sent, or undefined when it holds
 * neither text nor an image. Throws when an attached image cannot be read.
 */
export function chatSendFromComposer(operationId: string, message: ComposedMessage): ChatTabSend | undefined {
  const parts = [...message.content, ...(message.attachments ?? []).flatMap(attachment => attachment.content ?? [])];
  const images = parts.flatMap(part => {
    if (part.type !== 'image') return [];
    const match = DATA_URL.exec(part.image);
    if (!match) throw new Error('An attached image could not be read. Remove it and attach it again.');
    return [{ mimeType: match[1], data: match[2] }];
  });
  return chatSendRequest(operationId, composedText(message), images);
}

/**
 * The attachments to put back in the composer after it detached them on send, so
 * the draft stays visible (and editable after a failure) until the host confirms it.
 */
export function restorableAttachments(message: ComposedMessage): CreateAttachment[] {
  return (message.attachments ?? []).map(attachment => ({
    id: attachment.id, type: attachment.type, name: attachment.name, contentType: attachment.contentType, content: attachment.content ?? [],
  }));
}
