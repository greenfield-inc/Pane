import { open, mkdtemp, rm, stat, realpath } from 'fs/promises';
import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { pipeline } from 'stream/promises';
import { inspectSqliteSnapshot } from './sqlitePreview';
import type { FilePreviewListing } from '../../../shared/types/filePreview';

const MAX_ENTRIES = 1000;

/** Read directory metadata only. Never extract or decompress archive contents. */
export async function listArchive(filePath: string): Promise<FilePreviewListing> {
  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    const read = async (position: number, length: number) => {
      if (position < 0 || position + length > size) throw new Error('Invalid archive directory.');
      const bytes = Buffer.alloc(length);
      const result = await file.read(bytes, 0, length, position);
      if (result.bytesRead !== length) throw new Error('Archive changed while reading.');
      return bytes;
    };
    const rows: string[][] = [];
    let truncated = false;
    let extendedNames = false;
    if (extname(filePath).toLowerCase() === '.zip') {
      const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
      let end = tail.length - 22;
      while (end >= 0 && !(tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length)) end--;
      if (end < 0) throw new Error('Cannot preview this ZIP directory.');
      const count = tail.readUInt16LE(end + 10);
      const length = tail.readUInt32LE(end + 12);
      const offset = tail.readUInt32LE(end + 16);
      if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || count === 65535 || length === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 and split ZIP previews are unavailable.');
      if (length > 4 * 1024 * 1024) throw new Error('ZIP directory exceeds the 4 MiB preview limit.');
      const directory = await read(offset, length);
      let cursor = 0;
      for (let entry = 0; entry < Math.min(count, MAX_ENTRIES); entry++) {
        if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
        const nameLength = directory.readUInt16LE(cursor + 28);
        const next = cursor + 46 + nameLength + directory.readUInt16LE(cursor + 30) + directory.readUInt16LE(cursor + 32);
        if (next > length) throw new Error('Invalid ZIP entry.');
        const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        rows.push([name, String(directory.readUInt32LE(cursor + 24)), name.endsWith('/') ? 'Directory' : 'File']);
        cursor = next;
      }
      truncated = count > MAX_ENTRIES;
    } else {
      let offset = 0;
      let scanned = 0;
      while (offset + 512 <= size && scanned < MAX_ENTRIES) {
        const header = await read(offset, 512);
        if (header.every(byte => byte === 0)) break;
        const text = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
        const octal = (start: number, length: number) => {
          const value = text(start, length).trim();
          if (!/^[0-7]+$/.test(value)) throw new Error('Unsupported TAR header.');
          return parseInt(value, 8);
        };
        const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (octal(148, 8) !== checksum) throw new Error('Invalid TAR checksum.');
        const length = octal(124, 12);
        const next = offset + 512 + Math.ceil(length / 512) * 512;
        if (!Number.isSafeInteger(next) || next > size) throw new Error('Invalid TAR entry.');
        const type = text(156, 1);
        if (['x', 'g', 'L', 'K'].includes(type)) extendedNames = true;
        else {
          const prefix = text(257, 6).startsWith('ustar') ? text(345, 155) : '';
          rows.push([`${prefix ? `${prefix}/` : ''}${text(0, 100)}`, String(length), type === '5' ? 'Directory' : type === '2' ? 'Symlink' : 'File']);
        }
        offset = next; scanned++;
      }
      truncated = scanned === MAX_ENTRIES && offset < size;
      if (!rows.length && size < 512) throw new Error('Cannot preview this TAR directory.');
    }
    return { columns: ['Name', 'Bytes', 'Type'], rows, notice: `Archive listing only.${truncated ? ' Limited to 1,000 entries.' : ''}${extendedNames ? ' Extended TAR names are not expanded.' : ''}` };
  } finally { await file.close(); }
}

/** Inspect a bounded temporary snapshot so SQLite can never create source sidecars. */
export async function listSqlite(filePath: string, deadlineMs = 3000): Promise<FilePreviewListing> {
  // Recovery files belong beside the target, not beside a symlink alias.
  const sourcePath = await realpath(filePath);
  const source = await open(sourcePath, 'r');
  let directory: string | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new Error('SQLite preview is limited to 32 MiB.');
    // A hard link has no canonical owner path for locating its recovery files.
    if (before.nlink > 1) throw new Error('Cannot preview a database with hard links. Open a closed database copy.');
    const checkRecoveryFiles = async () => {
      for (const [suffix, label] of [['-wal', 'active WAL'], ['-journal', 'rollback journal']]) {
        const sidecar = await stat(`${sourcePath}${suffix}`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (sidecar?.size) throw new Error(`Cannot preview a database with a nonempty ${label}. Open a closed database copy.`);
      }
    };
    await checkRecoveryFiles();
    const signature = Buffer.alloc(16);
    await source.read(signature, 0, 16, 0);
    if (signature.toString('utf8') !== 'SQLite format 3\0') throw new Error('Cannot preview this SQLite database.');
    directory = await mkdtemp(join(tmpdir(), 'pane-sqlite-preview-'));
    const snapshot = join(directory, 'snapshot.sqlite');
    await pipeline(source.createReadStream({ start: 0, end: before.size - 1, autoClose: false }), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
    const after = await source.stat();
    await checkRecoveryFiles();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.nlink !== after.nlink) throw new Error('Database changed during preview. Try a closed copy.');
    return await inspectSqliteSnapshot(snapshot, deadlineMs);
  } finally {
    await source.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
