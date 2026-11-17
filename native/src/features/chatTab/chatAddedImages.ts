import type { ChatDraftImage } from './chatComposer';

/** Images another tab (the device tab's Screenshot to chat) added to a chat, waiting for its composer. */
const waiting = new Map<string, ChatDraftImage[]>();
const listeners = new Set<() => void>();

/** Adds an image to a chat's unsent draft: its composer takes it when shown, now or later. */
export function addChatImage(chatPanelId: string, image: ChatDraftImage): void {
  waiting.set(chatPanelId, [...(waiting.get(chatPanelId) ?? []), image]);
  for (const listener of listeners) listener();
}

/** The images waiting for `chatPanelId`, removed as they are taken. */
export function takeChatImages(chatPanelId: string): ChatDraftImage[] {
  const images = waiting.get(chatPanelId) ?? [];
  waiting.delete(chatPanelId);
  return images;
}

/** Calls `listener` whenever an image is added; returns the unsubscribe. */
export function onChatImageAdded(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
