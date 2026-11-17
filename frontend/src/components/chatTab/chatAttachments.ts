import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import type { UploadProgress } from '../../../../shared/chunkedUpload';
import { bytesToBase64 } from '../../../../shared/utils/base64';

/** Image types an agent takes as image content (ACP image blocks). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/**
 * The largest image sent as image content: the provider's own rule. Anthropic's API refuses an
 * image over 5 MB, and an image block goes to the model inline, so a larger image is copied to
 * the chat's machine as a file instead, and the agent reads it from there.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Copies a file of any size to the chat's machine (as the terminal's upload does) and returns its path there; `signal` stops it. */
export type SaveChatFile = (file: File, onProgress: (progress: UploadProgress) => void, signal: AbortSignal) => Promise<string>;

/** One file's copy to the chat's machine, which every chip showing that file watches. */
interface RunningCopy {
  controller: AbortController;
  done: Promise<string>;
  latest: UploadProgress;
  watchers: Set<(progress: UploadProgress) => void>;
}

/**
 * Copies still running, by file. A chat's draft keeps its attachments when the chat is left, and
 * re-adds the same File when it is back: that attachment watches the running copy instead of
 * starting a second one.
 */
const runningCopies = new Map<File, RunningCopy>();
/** Which file each attachment still copying shows, so removing the chip can stop its copy. */
const copyingFiles = new Map<string, File>();

function startCopy(file: File, saveFile: SaveChatFile, watch: (progress: UploadProgress) => void): RunningCopy {
  const controller = new AbortController();
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Copy cancelled')), { once: true });
  });
  const copy: RunningCopy = {
    controller,
    done: Promise.resolve(''),
    latest: { receivedBytes: 0, totalBytes: file.size, retrying: false, lastProgressAt: Date.now(), secondsLeft: null },
    watchers: new Set([watch]),
  };
  watch(copy.latest);
  const saved = saveFile(file, progress => {
    copy.latest = progress;
    for (const watch of copy.watchers) watch(progress);
  }, controller.signal);
  // Removing the chip ends the wait at once, even while a chunk is still in flight.
  copy.done = Promise.race([saved, stopped]).finally(() => {
    if (runningCopies.get(file) === copy) runningCopies.delete(file);
  });
  runningCopies.set(file, copy);
  return copy;
}

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

/** An image as a data URL. */
async function readDataUrl(file: File): Promise<string> {
  return `data:${file.type || 'application/octet-stream'};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;
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
    const watch = (progress: UploadProgress) => this.options.onProgress?.(id, progress);
    const running = runningCopies.get(file);
    if (running) {
      running.watchers.add(watch);
      watch(running.latest);
    }
    const copy = running ?? startCopy(file, saveFile, watch);
    copyingFiles.set(id, file);
    try {
      const path = await copy.done;
      yield { ...pending, content: [{ type: 'text', text: path }], status: { type: 'requires-action', reason: 'composer-send' } };
    } catch (error) {
      // Removed while copying: the chip is gone, and so is the copy.
      if (copy.controller.signal.aborted) return;
      throw new Error(`${file.name} was not attached: it could not be copied to the chat's machine (${ipcErrorMessage(error, 'Pane did not say why')}).`);
    } finally {
      copy.watchers.delete(watch);
      copyingFiles.delete(id);
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

  /** A chip removed while its file copies stops the copy (the host deletes what arrived), which frees Send. */
  async remove(attachment: PendingAttachment): Promise<void> {
    const file = copyingFiles.get(attachment.id);
    if (file) runningCopies.get(file)?.controller.abort();
  }
}

/** Files carried by a drag, when the browser says so (it may hide them until the drop). */
export function dragHasFiles(types: readonly string[] | DOMStringList | undefined): boolean {
  return !!types && [...types].includes('Files');
}
