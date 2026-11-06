import { createHash } from 'crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs';
import path from 'path';
import type { ChatTabSend } from '../../../../shared/types/chatTab';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

export type QueuedBody = Pick<ChatTabSend, 'text' | 'images'>;

const bodySchema = boundary.object({
  text: boundary.string,
  images: boundary.optional(boundary.array(boundary.object({ mimeType: boundary.string, data: boundary.string }))),
});

/**
 * The full text and images of queued prompts, one file each. A tab's saved state
 * holds only a short preview, because a panel's state row has a 256 KiB ceiling
 * and a prompt may carry megabytes of images.
 */
export class QueuedBodies {
  constructor(private readonly directory: (panelId: string) => string) {}

  /** Durable before it returns. */
  write(panelId: string, operationId: string, body: QueuedBody): void {
    const directory = this.directory(panelId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = this.file(panelId, operationId);
    const partial = `${file}.partial`;
    const descriptor = openSync(partial, 'w', 0o600);
    try {
      writeSync(descriptor, JSON.stringify(body));
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(partial, file);
  }

  read(panelId: string, operationId: string): QueuedBody | undefined {
    let json: string;
    try { json = readFileSync(this.file(panelId, operationId), 'utf8'); } catch { return undefined; }
    try { return decodeOptionalBoundary(JSON.parse(json), bodySchema); } catch { return undefined; }
  }

  /**
   * Best-effort: a file left behind is only wasted space, so a failed delete never
   * stops a prompt from being sent or a tab from closing.
   */
  remove(panelId: string, operationId: string): void { this.tryRemove(this.file(panelId, operationId), {}); }

  /** Best-effort, as remove is. */
  clear(panelId: string): void { this.tryRemove(this.directory(panelId), { recursive: true }); }

  private tryRemove(target: string, options: { recursive?: boolean }): void {
    try { rmSync(target, { ...options, force: true }); }
    catch (error) { console.warn(`[ChatTabs] A queued message's saved copy was not deleted (${target}): ${error instanceof Error ? error.message : String(error)}.`); }
  }

  private file(panelId: string, operationId: string): string {
    return path.join(this.directory(panelId), `${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}.json`);
  }
}
