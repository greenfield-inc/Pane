import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { artifactFileName, type ResolvedRelease } from './releases';

export interface DownloadedArtifact {
  path: string;
  fileName: string;
  usedFallback: boolean;
}

export async function downloadArtifact(
  resolved: ResolvedRelease,
  downloadDir?: string,
  verbose = false,
  onFallbackUsed?: (cause: unknown) => Promise<void> | void
): Promise<DownloadedArtifact> {
  const targetDir = downloadDir ?? path.join(os.tmpdir(), `runpane-${Date.now()}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const fileName = artifactFileName(resolved.artifact.name);
  const targetPath = path.join(targetDir, fileName);

  let usedFallback = false;
  try {
    await downloadToFile(resolved.preferredDownloadUrl, targetPath, verbose);
  } catch (error) {
    usedFallback = true;
    console.warn(`runpane: website download route failed; falling back to GitHub release asset. ${formatError(error)}`);
    try {
      await onFallbackUsed?.(error);
    } catch {
      // Fallback telemetry must not affect download behavior.
    }
    await downloadToFile(resolved.fallbackDownloadUrl, targetPath, verbose);
  }

  await verifyChecksumIfAvailable(resolved, targetPath, fileName);
  return { path: targetPath, fileName, usedFallback };
}

export async function downloadToFile(url: string, targetPath: string, verbose: boolean): Promise<void> {
  if (verbose) {
    console.log(`Downloading ${url}`);
  }

  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'runpane-installer' }
  });

  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  await pipeline(
    Readable.from(readResponseBody(response.body)),
    fs.createWriteStream(targetPath)
  );
}

async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function verifyChecksumIfAvailable(resolved: ResolvedRelease, artifactPath: string, fileName: string): Promise<void> {
  try {
    const response = await fetch(resolved.checksumUrl, {
      headers: { 'user-agent': 'runpane-installer' }
    });
    if (!response.ok) {
      return;
    }
    const checksums = await response.text();
    const expected = parseChecksum(checksums, fileName);
    if (!expected) {
      return;
    }
    const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    if (hash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Checksum mismatch for ${fileName}. Expected ${expected}, got ${hash}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Checksum mismatch')) {
      throw error;
    }
    console.warn(`runpane: could not verify checksum for ${fileName}. ${formatError(error)}`);
  }
}

export function parseChecksum(checksums: string, fileName: string): string | undefined {
  for (const line of checksums.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.endsWith(fileName)) continue;
    const [hash] = trimmed.split(/\s+/);
    if (/^[a-f0-9]{64}$/i.test(hash)) {
      return hash;
    }
  }
  return undefined;
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
