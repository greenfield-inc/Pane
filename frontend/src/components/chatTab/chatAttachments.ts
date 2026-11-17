import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import type { UploadProgress } from '../../../../shared/chunkedUpload';

/** Image types an agent takes as image content (ACP image blocks). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/**
 * The largest image sent as image content: the provider's own rule. Anthropic's API refuses an
 * image over 5 MB, and an image block goes to the model inline, so a larger image is copied to
 * the chat's machine as a file instead, and the agent reads it from there.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Copies a file of any size to the chat's machine (as the terminal's upload does) and returns its path there. */
export type SaveChatFile = (file: File, onProgress: (progress: UploadProgress) => void) => Promise<string>;

export interface ChatAttachmentOptions {
  /** The agent takes images as image content. */
  images: boolean;
  /** Copies other files to the chat's machine; without it only images can be attached. */
  saveFile?: SaveChatFile;
  /** Told how a file's copy is going, by attachment id, and null once it is done or failed, so the composer can show it and wait for it. */
  onProgress?: (id: string, progress: UploadProgress | null) => void;
  readDataUrl?: (file: File) => Promise<string>;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** An image as a data URL, read in 32 KiB slices so it never builds one huge argument list. */
async function readDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

/**
 * What a chat does with a dropped, pasted or picked file (D-139): an image the agent takes
 * becomes an image attachment; anything else is copied to the chat's machine and its path is
 * sent with the message, as the terminal does. Every refusal says why, and nothing is attached.
 */
export class ChatAttachmentAdapter implements AttachmentAdapter {
  /** Every file reaches `add`, so a refusal always says why in Pane's own words. */
  readonly accept = '*';

  constructor(private readonly options: ChatAttachmentOptions) {}

  /** Whether this chat can attach anything at all. */
  static available(options: ChatAttachmentOptions): boolean {
    return options.images || !!options.saveFile;
  }

  async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment, void> {
    const id = crypto.randomUUID();
    const image = IMAGE_TYPES.has(file.type);
    if (image && this.options.images && file.size <= MAX_IMAGE_BYTES) {
      yield { id, type: 'image', name: file.name, contentType: file.type, file, status: { type: 'requires-action', reason: 'composer-send' } };
      return;
    }
    const { saveFile } = this.options;
    if (!saveFile) {
      if (!this.options.images) throw new Error(`${file.name} was not attached: this chat can't take files or images here.`);
      if (image) throw new Error(`${file.name} was not attached: it is larger than ${megabytes(MAX_IMAGE_BYTES)}, the most a chat sends as an image.`);
      throw new Error(`${file.name} was not attached: this chat takes PNG, JPEG, WebP or GIF images here, and can't copy other files.`);
    }
    const pending: PendingAttachment = { id, type: 'file', name: file.name, contentType: file.type, file, status: { type: 'running', reason: 'uploading', progress: 0 } };
    yield pending;
    this.options.onProgress?.(id, { receivedBytes: 0, totalBytes: file.size, retrying: false, lastProgressAt: Date.now(), secondsLeft: null });
    try {
      const path = await saveFile(file, progress => this.options.onProgress?.(id, progress));
      yield { ...pending, content: [{ type: 'text', text: path }], status: { type: 'requires-action', reason: 'composer-send' } };
    } catch (error) {
      throw new Error(`${file.name} was not attached: it could not be copied to the chat's machine (${ipcErrorMessage(error, 'Pane did not say why')}).`);
    } finally {
      this.options.onProgress?.(id, null);
    }
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    if (attachment.type === 'image') {
      const image = await (this.options.readDataUrl ?? readDataUrl)(attachment.file);
      return { ...attachment, status: { type: 'complete' }, content: [{ type: 'image', image }] };
    }
    // The file is already on the chat's machine; the message carries its path.
    return { ...attachment, status: { type: 'complete' }, content: attachment.content ?? [] };
  }

  async remove(): Promise<void> {}
}

/** Files carried by a drag, when the browser says so (it may hide them until the drop). */
export function dragHasFiles(types: readonly string[] | DOMStringList | undefined): boolean {
  return !!types && [...types].includes('Files');
}
