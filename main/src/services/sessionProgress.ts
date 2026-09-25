import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { sessionWorkspacePath } from './sessionWorkspace';
import type { SessionProgress } from '../../../shared/types/orchestrationSession';

const MAX_BYTES = 1024 * 1024;

export async function readSessionProgress(sessionId: string, enabled: boolean): Promise<SessionProgress> {
  if (!enabled) return { state: 'disabled' };
  const directory = sessionWorkspacePath(sessionId);
  try {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Session workspace must not be a symbolic link');
    const filePath = path.join(directory, 'progress.html');
    const entry = await fs.lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Session progress must be a regular file');
    const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Session progress must be a regular file');
      if (stat.size > MAX_BYTES) throw new Error('Session progress exceeds 1 MiB');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > MAX_BYTES) throw new Error('Session progress exceeds 1 MiB');
      const html = buffer.subarray(0, length).toString('utf8');
      if (!html.trim()) return { state: 'empty' };
      return { state: 'ready', html, revision: createHash('sha256').update(html).digest('hex') };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { state: 'empty' };
    throw error;
  }
}
