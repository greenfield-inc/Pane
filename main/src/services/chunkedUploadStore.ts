import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { MACHINE_HEALTH_DEFAULTS } from '../../../shared/types/machineHealth';
import { UPLOAD_INVALID_CODE, UPLOAD_NO_ROOM_CODE, UPLOAD_NO_ROOM_MESSAGE } from '../../../shared/chunkedUpload';
import { PaneError } from '../../../shared/paneError';
import { formatBytes } from '../../../shared/utils/formatBytes';
import { readDiskVolumes } from './machineHealth/diskSpace';

const GB = 1024 ** 3;
/** Partial uploads untouched this long are deleted. */
const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1000;

export interface UploadStart {
  uploadId: string;
  sessionId: string;
  fileName: string;
  mimeType: string;
  size: number;
  md5: string;
  /** Lands under its own name, in a folder of its own (a chat attachment). */
  keepName?: boolean;
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
  private readonly freeBytes: (dir: string) => Promise<number | null>;
  private readonly reserveBytes: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * `freeBytes` reads the volume as Machine health does; `reserveBytes` is what
   * an upload must leave free (Machine health's critical level by default).
   */
  constructor({ dir, now = Date.now, freeBytes = readFreeBytes, reserveBytes = () => MACHINE_HEALTH_DEFAULTS.diskCriticalGB * GB }: {
    dir: string;
    now?: () => number;
    freeBytes?: (dir: string) => Promise<number | null>;
    reserveBytes?: () => number;
  }) {
    this.dir = dir;
    this.now = now;
    this.freeBytes = freeBytes;
    this.reserveBytes = reserveBytes;
  }

  /** The only size rule: the rest of the file must fit in the host's free space minus the reserve. */
  async start(input: UploadStart): Promise<{ receivedBytes: number }> {
    assertUploadId(input.uploadId);
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw invalid('Invalid upload size: the file size must be a whole number of bytes.');
    await fs.mkdir(this.dir, { recursive: true });
    await this.sweep();
    return this.exclusive(input.uploadId, async () => {
      const existing = await this.readRecord(input.uploadId);
      if (existing) {
        if (existing.size !== input.size || existing.md5 !== input.md5 || existing.sessionId !== input.sessionId) {
          throw invalid('Upload ID already used for a different file, so this upload was not resumed.');
        }
        await this.touch(input.uploadId);
        if (existing.committedPath) return { receivedBytes: existing.size };
        const received = await this.receivedBytes(input.uploadId);
        await this.assertRoomFor(input.uploadId, input.fileName, input.size - received);
        return { receivedBytes: received };
      }
      await this.assertRoomFor(input.uploadId, input.fileName, input.size);
      const record: UploadRecord = {
        uploadId: input.uploadId,
        sessionId: input.sessionId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: input.size,
        md5: input.md5.toLowerCase(),
      };
      if (input.keepName) record.keepName = true;
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
      if (received + bytes.length > record.size) throw invalid('Chunk runs past the declared file size, so it was not saved.');
      // Every chunk, so uploads running side by side (or a disk filling up meanwhile) stop with the reserve still free.
      await this.assertRoomFor(uploadId, record.fileName, record.size - received);
      await fs.appendFile(this.partPath(uploadId), bytes).catch(async (error: NodeJS.ErrnoException) => {
        // The disk filled up anyway: refuse with the numbers rather than retry forever.
        if (error.code !== 'ENOSPC') throw error;
        await this.remove(uploadId);
        throw this.noRoom(record.fileName, record.size - received, await this.freeBytes(this.dir).catch(() => null) ?? 0);
      });
      await this.touch(uploadId);
      return { receivedBytes: received + bytes.length };
    });
  }

  /**
   * Checks the bytes, hands the finished file's path to `save` (the same
   * landing code as a single-request upload, which moves it into place) and
   * remembers where it landed, so committing twice returns the same file.
   * The file is read as a stream, so its size costs no memory.
   */
  async commit(uploadId: string, save: (record: UploadRecord, filePath: string) => Promise<string>): Promise<{ filePath: string }> {
    assertUploadId(uploadId);
    return this.exclusive(uploadId, async () => {
      const record = await this.requireRecord(uploadId);
      if (record.committedPath) return { filePath: record.committedPath };
      const received = await this.receivedBytes(uploadId);
      if (received !== record.size) {
        throw new Error(`Upload incomplete: ${received} of ${record.size} bytes received`);
      }
      // Desktop and some Android files send no checksum; size and offsets still guard those uploads.
      if (record.md5 && await md5Of(this.partPath(uploadId)) !== record.md5) {
        throw invalid('Upload checksum mismatch: the file arrived different from the one sent, so it was not saved.');
      }
      const filePath = await save(record, this.partPath(uploadId));
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

  /**
   * Throws, naming the numbers, when `bytes` more would leave less than the reserve
   * free, and deletes what arrived so far: a refused upload holds no space.
   */
  private async assertRoomFor(uploadId: string, fileName: string, bytes: number): Promise<void> {
    // A volume Machine health can't read doesn't block the upload; a full disk still stops it (ENOSPC).
    const free = await this.freeBytes(this.dir).catch(() => null);
    if (free === null || free - this.reserveBytes() >= bytes) return;
    await this.remove(uploadId);
    throw this.noRoom(fileName, bytes, free);
  }

  private noRoom(fileName: string, bytes: number, free: number): PaneError {
    return new PaneError(
      UPLOAD_NO_ROOM_CODE,
      `${UPLOAD_NO_ROOM_MESSAGE}: ${fileName} needs ${formatBytes(bytes)}, ${formatBytes(free)} is free, `
        + `and Pane keeps ${formatBytes(this.reserveBytes())} free (Settings > Machine health). Nothing was saved.`,
      'Free up space here, or send a smaller file.',
    );
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
  if (!UPLOAD_ID.test(uploadId)) throw invalid('Invalid upload ID: it must be 8 to 64 letters, digits, - or _.');
}

/** The upload can't be taken as sent; the client stops instead of retrying. */
function invalid(message: string): PaneError {
  return new PaneError(UPLOAD_INVALID_CODE, message, 'Send the file again.');
}

/** Free space on the volume holding `dir`, read the way Machine health reads it; null when unreadable. */
async function readFreeBytes(dir: string): Promise<number | null> {
  const [volume] = await readDiskVolumes([{ path: dir, role: 'pane-data' }]);
  return volume?.freeBytes ?? null;
}

async function md5Of(filePath: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

