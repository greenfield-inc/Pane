import type { ChatTabQueuedPrompt, ChatTabSend } from '@shared/types/chatTab';

/** The same limits desktop's composer puts on an attached image. */
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** The image types an agent reads, as desktop's composer accepts them. */
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** An image attached to the draft: what the thumbnail shows and what the message carries. */
export interface ChatDraftImage {
  key: string;
  uri: string;
  mimeType: string;
  /** The image's bytes, base64-encoded. */
  data: string;
}

/** Why an image can't be attached, or undefined when it can. */
export function chatImageProblem(image: { mimeType: string; size: number }): string | undefined {
  if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(image.mimeType)) return 'Choose a PNG, JPEG, WebP or GIF image.';
  if (image.size > CHAT_IMAGE_MAX_BYTES) return 'Choose an image smaller than 5 MiB.';
  return undefined;
}

/** The message to send, or undefined when the draft has neither text nor an image. */
export function chatSendRequest(operationId: string, draft: string, images: readonly { mimeType: string; data: string }[]): ChatTabSend | undefined {
  const text = draft.trim() ? draft : '';
  if (!text && !images.length) return undefined;
  return images.length
    ? { operationId, text, images: images.map(({ mimeType, data }) => ({ mimeType, data })) }
    : { operationId, text };
}

/** What a queued message shows: its text preview, or its images when it has no text. */
export function queuedLabel(item: Pick<ChatTabQueuedPrompt, 'text' | 'images' | 'imageCount'>): string {
  if (item.text) return item.text;
  const count = item.imageCount ?? item.images?.length ?? 0;
  if (count === 1) return '1 image';
  return count > 1 ? `${count} images` : 'Image';
}
