import type { Attachment as ComposerAttachment } from '@assistant-ui/react';
import type { ChatTabClient } from '../../../../shared/types/chatTab';
import { chatTabViewer, type ChatTabViewer } from '../../../../shared/chatTabViewer';

/**
 * The attachments of each chat's unsent draft, kept with its viewer as the draft text is: the
 * composer is rebuilt when the tab or its Pane is shown again, and they go back into it then.
 */
export const draftAttachments = new WeakMap<ChatTabViewer, readonly ComposerAttachment[]>();
/** The composer each shown chat has now, so another tab (the device tab's Screenshot to chat) can add to its draft. */
export const shownComposers = new Map<ChatTabViewer, { addAttachment(file: File): Promise<void> }>();

/**
 * Adds `file` to a chat's unsent draft, never sending it: straight into its composer when the chat
 * is shown, else into its saved draft, which goes back into the composer when the chat shows.
 */
export async function addDraftAttachment(client: ChatTabClient, panelId: string, file: File): Promise<void> {
  const viewer = chatTabViewer(client, panelId);
  const composer = shownComposers.get(viewer);
  if (composer) return composer.addAttachment(file);
  const pending: ComposerAttachment = { id: crypto.randomUUID(), type: file.type.startsWith('image/') ? 'image' : 'file', name: file.name, contentType: file.type, file, status: { type: 'requires-action', reason: 'composer-send' } };
  draftAttachments.set(viewer, [...(draftAttachments.get(viewer) ?? []), pending]);
}
