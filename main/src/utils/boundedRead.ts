import fs from 'fs';

/**
 * The file's bytes, or `null` when it holds more than `limit`. The size is checked on the open file
 * and the read stops one byte past the limit, so a file that grows after a stat is never read whole.
 */
export function readUpTo(file: string, limit: number): Buffer | null {
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    let read = 0;
    while (read < buffer.length) {
      const got = fs.readSync(fd, buffer, read, buffer.length - read, read);
      if (got === 0) break;
      read += got;
    }
    return read > limit ? null : buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}
