import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * The checked copy that `runpane handoff` and Pane's whole-Session move share: files cross
 * machines in machine writes of at most this many bytes, every file is checked by SHA-256 on
 * arrival, and a copy already on the destination is replaced only when the incoming copy holds
 * everything it does (history continued there is never overwritten).
 */
export const WRITE_CHUNK_BYTES = 8 * 1024 * 1024;

export interface FileDigest {
  bytes: number;
  sha256: string;
}

/**
 * Whether the destination's copy has history the incoming copy doesn't: it is longer, or its
 * bytes differ from the incoming copy's first `existing.bytes`. `prefixSha256` is the SHA-256
 * of exactly that many leading bytes of the incoming copy (or of all of it when shorter).
 */
export function divergedCopy(existing: FileDigest, incomingBytes: number, prefixSha256: string): boolean {
  return existing.bytes > incomingBytes || prefixSha256 !== existing.sha256;
}

/** SHA-256 and size of a file, read in chunks so a large file never loads whole. `limit` hashes only that many leading bytes. */
export async function fileDigest(file: string, limit = Number.POSITIVE_INFINITY): Promise<FileDigest> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = fs.createReadStream(file, Number.isFinite(limit) ? { start: 0, end: Math.max(0, limit) - 1 } : {});
  if (limit === 0) {
    stream.destroy();
    return { bytes: 0, sha256: hash.digest('hex') };
  }
  for await (const chunk of stream) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}
