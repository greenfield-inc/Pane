import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import zlib from 'zlib';
import { PaneError } from '../../../../shared/paneError';
import { boundary } from '../../../../shared/validation/boundaryDecoder';
import { fileDigest, WRITE_CHUNK_BYTES } from '../../../../packages/runpane/src/checkedCopy';
import { isSafePackagePath, type PackageFile } from './manifest';

/**
 * The move's checked copy (handoff's chunk size and SHA-256 rule, `checkedCopy.ts`): each file is
 * gzipped as it is read and sent in machine writes of at most 8 MiB, so a 500 MB package never
 * loads into memory. The target unpacks it into its staging folder and refuses it unless its size
 * and SHA-256 match the source's.
 */

export interface WriteRequest {
  moveId: string;
  path: string;
  /** Where this chunk starts in the compressed file; a retried chunk overwrites from there. */
  offset: number;
  /** Base64 of the compressed bytes. */
  content: string;
  /** On the final chunk: the original file's size and SHA-256. */
  last?: { bytes: number; sha256: string };
}

export type WriteResult = { received: number } | PackageFile;

export const writeRequestSchema = boundary.object({
  moveId: boundary.nonEmptyString,
  path: boundary.nonEmptyString,
  offset: boundary.refine(boundary.number, value => Number.isInteger(value) && value >= 0, 'expected a byte offset'),
  content: boundary.string,
  last: boundary.optional(boundary.object({ bytes: boundary.number, sha256: boundary.string })),
});

export const writeResultSchema = boundary.union(
  boundary.object({ received: boundary.number }),
  boundary.object({ path: boundary.string, bytes: boundary.number, sha256: boundary.string }),
);

export interface ChunkSender {
  write(request: WriteRequest): Promise<WriteResult>;
}

const MOVE_ID = /^[A-Za-z0-9-]{8,64}$/;
const ATTEMPTS = 3;

/** The target's side: a staging folder per move, under the Pane folder. */
export class MoveReceiver {
  /** `maxFileBytes`: a file that unpacks larger than this is refused and removed (profile sync, review F-10). */
  constructor(private readonly root: string, private readonly limits: { maxFileBytes?: number } = {}) {}

  moveDir(moveId: string): string {
    if (!MOVE_ID.test(moveId)) throw new PaneError('ERR_MOVE_ID', `"${moveId}" is not a move id, so nothing was written.`, 'Start the move again from the other machine.');
    return path.join(this.root, moveId);
  }

  /** Where an unpacked, checked package file is. */
  filePath(moveId: string, packagePath: string): string {
    if (!isSafePackagePath(packagePath)) {
      throw new PaneError('ERR_MOVE_PACKAGE_PATH', `"${packagePath}" is not a package path inside the move, so it was refused.`, 'Start the move again; if it repeats, report it.');
    }
    return path.join(this.moveDir(moveId), 'package', ...packagePath.split('/'));
  }

  async write(request: WriteRequest): Promise<WriteResult> {
    const target = this.filePath(request.moveId, request.path);
    const compressed = path.join(this.moveDir(request.moveId), 'incoming', ...request.path.split('/')) + '.gz';
    await fs.promises.mkdir(path.dirname(compressed), { recursive: true });
    const size = await fs.promises.stat(compressed).then(stat => stat.size, () => 0);
    if (request.offset > size) {
      throw new PaneError('ERR_MOVE_CHUNK_ORDER', `A chunk of ${request.path} arrived at byte ${request.offset}, but only ${size} bytes are here.`, 'The source resends from the start of the file.');
    }
    // A retried chunk replaces whatever of it arrived before the call failed.
    if (request.offset < size) await fs.promises.truncate(compressed, request.offset);
    await fs.promises.appendFile(compressed, Buffer.from(request.content, 'base64'));
    if (!request.last) return { received: request.offset + Buffer.byteLength(request.content, 'base64') };

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    const count = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        hash.update(chunk);
        bytes += chunk.length;
        const max = this.limits.maxFileBytes;
        if (max !== undefined && bytes > max) done(new Error(`it unpacks to more than ${max} bytes`));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(fs.createReadStream(compressed), zlib.createGunzip(), count, fs.createWriteStream(target));
    } catch (error) {
      await fs.promises.rm(target, { force: true });
      await fs.promises.rm(compressed, { force: true });
      throw new PaneError('ERR_MOVE_PACKAGE_DAMAGED', `${request.path} arrived damaged (${error instanceof Error ? error.message : String(error)}). It was removed.`, 'The source sends it again.');
    }
    await fs.promises.rm(compressed, { force: true });
    const sha256 = hash.digest('hex');
    if (bytes !== request.last.bytes || sha256 !== request.last.sha256) {
      await fs.promises.rm(target, { force: true });
      throw new PaneError('ERR_MOVE_DIGEST_MISMATCH', `${request.path} doesn't match the source's copy (${bytes} bytes here, ${request.last.bytes} there, or a different SHA-256). It was removed.`, 'The move is cancelled; try again.');
    }
    return { path: request.path, bytes, sha256 };
  }

  /** Re-checks an unpacked file against the manifest before anything is built from it. */
  async verify(moveId: string, file: PackageFile): Promise<boolean> {
    const target = this.filePath(moveId, file.path);
    if (!fs.existsSync(target)) return false;
    const digest = await fileDigest(target);
    return digest.bytes === file.bytes && digest.sha256 === file.sha256;
  }

  async remove(moveId: string): Promise<void> {
    await fs.promises.rm(this.moveDir(moveId), { recursive: true, force: true });
  }
}

async function withRetry<T>(work: () => Promise<T>, label: string): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      // A digest mismatch or a refused path won't change on a retry.
      if (error instanceof PaneError && ['ERR_MOVE_DIGEST_MISMATCH', 'ERR_MOVE_PACKAGE_PATH', 'ERR_MOVE_ID'].includes(error.code)) throw error;
    }
  }
  const reason = last instanceof Error ? last.message : String(last);
  throw new PaneError('ERR_MOVE_SEND_FAILED', `Sending ${label} failed ${ATTEMPTS} times: ${reason}`, 'Check the connection between the two machines, then try again.');
}

/** Sends one file, compressed and in chunks; resolves with the target's checked size and SHA-256. */
export async function sendFile(sender: ChunkSender, moveId: string, packagePath: string, file: string, { chunkBytes = WRITE_CHUNK_BYTES }: { chunkBytes?: number } = {}): Promise<PackageFile> {
  const original = await fileDigest(file);
  let offset = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const flush = async (bytes: number) => {
    const all = Buffer.concat(pending);
    const chunk = all.subarray(0, bytes);
    const rest = all.subarray(bytes);
    const at = offset;
    await withRetry(() => sender.write({ moveId, path: packagePath, offset: at, content: chunk.toString('base64') }), packagePath);
    offset += chunk.length;
    pending = rest.length ? [Buffer.from(rest)] : [];
    pendingBytes = rest.length;
  };
  for await (const piece of fs.createReadStream(file).pipe(zlib.createGzip())) {
    const buffer = piece instanceof Buffer ? piece : Buffer.from(String(piece));
    pending.push(buffer);
    pendingBytes += buffer.length;
    while (pendingBytes >= chunkBytes) await flush(chunkBytes);
  }
  const tail = Buffer.concat(pending);
  const result = await withRetry(() => sender.write({ moveId, path: packagePath, offset, content: tail.toString('base64'), last: original }), packagePath);
  if (!('sha256' in result) || result.sha256 !== original.sha256 || result.bytes !== original.bytes) {
    throw new PaneError('ERR_MOVE_DIGEST_MISMATCH', `${packagePath} doesn't match on the other machine.`, 'The move is cancelled; try again.');
  }
  return result;
}
