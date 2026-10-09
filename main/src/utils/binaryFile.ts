import { open } from 'fs/promises';
import { mediaFileKind } from '../../../shared/utils/mediaFile';

/** Inspect at most 8 KiB; allow partial trailing UTF-8 only if bytes remain on disk. */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  if (mediaFileKind(filePath)) return true;
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.some(byte => byte === 0 || byte < 7 || (byte > 13 && byte < 32))) return true;
    const hasMoreBytes = bytesRead === buffer.length && (await file.stat()).size > bytesRead;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: hasMoreBytes });
      return false;
    } catch {
      return true;
    }
  } finally {
    await file.close();
  }
}
