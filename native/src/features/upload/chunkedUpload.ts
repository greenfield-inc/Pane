/** Same cap as the host's upload store and desktop's upload button. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** About 27 s per chunk at 50 kbps once base64-encoded, well inside every timeout on the way. */
const CHUNK_BYTES = 128 * 1024;
/** A chunk that hasn't finished by then is treated as lost and retried. */
const CHUNK_TIMEOUT_MS = 3 * 60 * 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** A picked file the upload reads in slices. */
export interface UploadFile {
  name: string;
  mimeType: string;
  size: number;
  md5: string;
  /** Returns `length` bytes from `offset`, base64-encoded. */
  read(offset: number, length: number): Promise<string>;
}

export interface UploadProgress {
  receivedBytes: number;
  totalBytes: number;
  /** True while waiting to retry after a failed request. */
  retrying: boolean;
  /** When the host last confirmed new bytes (or the upload began). */
  lastProgressAt: number;
}

export interface UploadOptions {
  invoke: (channel: string, args: unknown[]) => Promise<unknown>;
  file: UploadFile;
  sessionId: string;
  /** Stable for the life of this upload, so a retry resumes it instead of starting over. */
  uploadId: string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  chunkBytes?: number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** The host turned the file down; retrying won't help. */
export class UploadRefusedError extends Error {
  override name = 'UploadRefusedError';
}

/** The host predates chunked upload; use the single-request upload instead. */
export class ChunkedUploadUnsupportedError extends Error {
  override name = 'ChunkedUploadUnsupportedError';
}

/** Host replies that mean the file itself is the problem. Anything else is treated as a dropped connection. */
const REFUSALS = /File too large|already used for a different file|checksum mismatch|Invalid upload/;

/**
 * Sends a file to the host in chunks and returns the path the host saved it
 * at. Every reply carries the bytes the host holds, and the next chunk starts
 * there, so a repeated chunk or a lost reply costs nothing. A failure waits,
 * asks the host where to resume (`upload-start` again) and carries on, for as
 * long as it takes, until the host refuses the file or the signal aborts.
 */
export async function uploadInChunks({
  invoke,
  file,
  sessionId,
  uploadId,
  signal,
  onProgress,
  chunkBytes = CHUNK_BYTES,
  wait = sleep,
  now = Date.now,
}: UploadOptions): Promise<string> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadRefusedError(`File too large (${megabytes(file.size)} MB, max ${megabytes(MAX_UPLOAD_BYTES)} MB)`);
  }
  let received = 0;
  let lastProgressAt = now();
  let failures = 0;
  const report = (retrying: boolean) => onProgress?.({ receivedBytes: received, totalBytes: file.size, retrying, lastProgressAt });
  const call = <T>(channel: string, args: unknown[]) => withTimeout(invoke(channel, args) as Promise<T>, CHUNK_TIMEOUT_MS);
  const moveTo = (bytes: number) => {
    if (bytes > received) lastProgressAt = now();
    received = bytes;
  };

  let started = false;
  for (;;) {
    throwIfCancelled(signal);
    try {
      if (!started) {
        const start = await call<{ receivedBytes: number }>('terminal:upload-start', [{
          uploadId, sessionId, fileName: file.name, mimeType: file.mimeType, size: file.size, md5: file.md5,
        }]);
        started = true;
        moveTo(start.receivedBytes);
        report(false);
      }
      while (received < file.size) {
        throwIfCancelled(signal);
        const data = await file.read(received, Math.min(chunkBytes, file.size - received));
        const reply = await call<{ receivedBytes: number }>('terminal:upload-chunk', [uploadId, received, data]);
        moveTo(reply.receivedBytes);
        failures = 0;
        report(false);
      }
      throwIfCancelled(signal);
      const { filePath } = await call<{ filePath: string }>('terminal:upload-commit', [uploadId]);
      return filePath;
    } catch (error) {
      if (signal?.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('No Pane daemon command registered')) throw new ChunkedUploadUnsupportedError(message);
      if (REFUSALS.test(message)) throw new UploadRefusedError(refusalText(message));
      // Ask the host where things stand before sending anything else.
      started = false;
      report(true);
      await wait(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 30000, signal);
      failures += 1;
    }
  }
  await invoke('terminal:upload-cancel', [uploadId]).catch(() => undefined);
  throw new Error('Upload cancelled');
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Upload cancelled');
}

/** The remote client wraps host errors ("… before trying again. (reason)"); keep the host's reason. */
function refusalText(message: string): string {
  return message.match(/before trying again\. \((.*)\)$/s)?.[1] ?? message;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Upload request timed out')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}
