import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

/** Same cap as `terminal:paste-file` and desktop's upload button. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Partial uploads untouched this long are deleted. */
const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1000;

export interface UploadStart {
  uploadId: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  size: number;
  md5: string;
}

export interface UploadRecord extends UploadStart {
  committedPath?: string;
}

const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Staging for uploads that arrive in chunks over a slow, flaky link. Each
 * upload is a `.part` file plus a `.json` record. Appends name their offset,
 * and every reply carries the bytes received so far, so a retried chunk is
 * harmless, a lost one is resent, and starting the same upload again is how a
 * client resumes.
 */
export class ChunkedUploadStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor({ dir, now = Date.now }: { dir: string; now?: () => number }) {
    this.dir = dir;
    this.now = now;
  }

  async start(input: UploadStart): Promise<{ receivedBytes: number }> {
    assertUploadId(input.uploadId);
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error('Invalid upload size');
    if (input.size > MAX_UPLOAD_BYTES) {
      throw new Error(`File too large (${formatMegabytes(input.size)} MB, max ${formatMegabytes(MAX_UPLOAD_BYTES)} MB)`);
    }
    await fs.mkdir(this.dir, { recursive: true });
    await this.sweep();
    return this.exclusive(input.uploadId, async () => {
      const existing = await this.readRecord(input.uploadId);
      if (existing) {
        if (existing.size !== input.size || existing.md5 !== input.md5 || existing.sessionId !== input.sessionId) {
          throw new Error('Upload ID already used for a different file');
        }
        await this.touch(input.uploadId);
        return { receivedBytes: existing.committedPath ? existing.size : await this.receivedBytes(input.uploadId) };
      }
      const record: UploadRecord = {
        uploadId: input.uploadId,
        sessionId: input.sessionId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: input.size,
        md5: input.md5.toLowerCase(),
      };
      await fs.writeFile(this.partPath(input.uploadId), Buffer.alloc(0));
      await this.writeRecord(record);
      return { receivedBytes: 0 };
    });
  }

  async append(uploadId: string, offset: number, base64: string): Promise<{ receivedBytes: number }> {
    assertUploadId(uploadId);
    return this.exclusive(uploadId, async () => {
      const record = await this.requireRecord(uploadId);
      const received = record.committedPath ? record.size : await this.receivedBytes(uploadId);
      const bytes = Buffer.from(base64, 'base64');
      // A chunk the host already has (a retry whose reply was lost) changes nothing.
      if (offset + bytes.length <= received) return { receivedBytes: received };
      // A chunk past the end (an earlier one was lost) is dropped; the reply says where to resume.
      if (offset !== received) return { receivedBytes: received };
      if (received + bytes.length > record.size) throw new Error('Chunk runs past the declared file size');
      await fs.appendFile(this.partPath(uploadId), bytes);
      await this.touch(uploadId);
      return { receivedBytes: received + bytes.length };
    });
  }

  /**
   * Checks the bytes, hands them to `save` (the same landing code as a
   * single-request upload) and remembers the path, so committing twice
   * returns the same file.
   */
  async commit(uploadId: string, save: (record: UploadRecord, bytes: Buffer) => Promise<string>): Promise<{ filePath: string }> {
    assertUploadId(uploadId);
    return this.exclusive(uploadId, async () => {
      const record = await this.requireRecord(uploadId);
      if (record.committedPath) return { filePath: record.committedPath };
      const bytes = await fs.readFile(this.partPath(uploadId));
      if (bytes.length !== record.size) {
        throw new Error(`Upload incomplete: ${bytes.length} of ${record.size} bytes received`);
      }
      // Android can't always hash a content:// file; size and offsets still guard those uploads.
      if (record.md5 && createHash('md5').update(bytes).digest('hex') !== record.md5) {
        throw new Error('Upload checksum mismatch');
      }
      const filePath = await save(record, bytes);
      await fs.rm(this.partPath(uploadId), { force: true });
      await this.writeRecord({ ...record, committedPath: filePath });
      return { filePath };
    });
  }

  async cancel(uploadId: string): Promise<void> {
    assertUploadId(uploadId);
    await this.exclusive(uploadId, () => this.remove(uploadId));
  }

  /** Deletes uploads (finished or not) that nothing has touched for a day. */
  async sweep(): Promise<void> {
    const names: string[] = await fs.readdir(this.dir).catch(() => []);
    const cutoff = this.now() - ABANDONED_UPLOAD_MS;
    await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      const uploadId = name.slice(0, -'.json'.length);
      const stat = await fs.stat(path.join(this.dir, name)).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await this.remove(uploadId);
    }));
  }

  private async remove(uploadId: string): Promise<void> {
    await fs.rm(this.partPath(uploadId), { force: true });
    await fs.rm(this.recordPath(uploadId), { force: true });
  }

  private async receivedBytes(uploadId: string): Promise<number> {
    const stat = await fs.stat(this.partPath(uploadId)).catch(() => null);
    return stat?.size ?? 0;
  }

  private async touch(uploadId: string): Promise<void> {
    const time = new Date(this.now());
    await fs.utimes(this.recordPath(uploadId), time, time).catch(() => undefined);
  }

  private async requireRecord(uploadId: string): Promise<UploadRecord> {
    const record = await this.readRecord(uploadId);
    if (!record) throw new Error('Upload not found. Start it again.');
    return record;
  }

  private async readRecord(uploadId: string): Promise<UploadRecord | null> {
    const text = await fs.readFile(this.recordPath(uploadId), 'utf8').catch(() => null);
    // SAFETY: the record is written only by writeRecord, from a validated UploadRecord.
    return text ? JSON.parse(text) as UploadRecord : null;
  }

  private async writeRecord(record: UploadRecord): Promise<void> {
    await fs.writeFile(this.recordPath(record.uploadId), JSON.stringify(record));
    await this.touch(record.uploadId);
  }

  private partPath(uploadId: string) {
    return path.join(this.dir, `${uploadId}.part`);
  }

  private recordPath(uploadId: string) {
    return path.join(this.dir, `${uploadId}.json`);
  }

  /** One operation per upload at a time, so a retry racing its original can't append twice. */
  private exclusive<T>(uploadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(uploadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(uploadId, next);
    void next.finally(() => {
      if (this.locks.get(uploadId) === next) this.locks.delete(uploadId);
    }).catch(() => undefined);
    return next;
  }
}

function assertUploadId(uploadId: string): void {
  if (!UPLOAD_ID.test(uploadId)) throw new Error('Invalid upload ID');
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}
