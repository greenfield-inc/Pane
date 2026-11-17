import { boundary, decodeBoundary, type JsonObject, type JsonValue } from './validation/boundaryDecoder';

/** The first chunk: about 27 s at 50 kbps once base64-encoded, well inside every timeout on the way. */
const FIRST_CHUNK_BYTES = 128 * 1024;
/** Chunks grow on a fast link up to this, which stays under the host's 16 MB request limit once base64-encoded. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
/** Chunk sizes aim for this long per request: few requests on a fast link, short ones on a slow link. */
const TARGET_CHUNK_MS = 2000;
/** A chunk that hasn't finished by then is treated as lost and retried. */
const CHUNK_TIMEOUT_MS = 3 * 60 * 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/** A chunk this much slower than the last one (and at least STALL_MS) counts as a stalled connection. */
const STALL_FACTOR = 3;
const STALL_MS = 10_000;
/** Before any chunk has come back: room for 128 KB on a 50 kbps link. */
const FIRST_STALL_MS = 30_000;
/** Time left is estimated from the speed over this window. */
const SPEED_WINDOW_MS = 20_000;
/** Time left is shown once this much of a run has passed, so the first chunk's guess isn't. */
const ESTIMATE_AFTER_MS = 3000;

/** A file the upload reads in slices. */
export interface UploadFile {
  name: string;
  mimeType: string;
  size: number;
  /** Hex MD5 of the whole file, or '' when the client can't compute one. */
  md5: string;
  /** Returns `length` bytes from `offset`, base64-encoded. */
  read(offset: number, length: number): Promise<string>;
}

export interface UploadProgress {
  receivedBytes: number;
  totalBytes: number;
  /** True while waiting to retry after a failed request, or while a request has stalled. */
  retrying: boolean;
  /** When the host last confirmed new bytes (or the upload began). */
  lastProgressAt: number;
  /** Seconds until done at the recent speed; null while there is no estimate yet. */
  secondsLeft: number | null;
}

/** Calls a host command, as the phone's, desktop's and PWA's clients do. */
export type UploadInvoke = (channel: string, args: JsonValue[]) => Promise<JsonValue | undefined>;

const receivedSchema = boundary.object({ receivedBytes: boundary.number });
const committedSchema = boundary.object({ filePath: boundary.nonEmptyString });

export interface UploadOptions {
  invoke: UploadInvoke;
  file: UploadFile;
  sessionId: string;
  /** Stable for the life of this upload, so a retry resumes it instead of starting over. */
  uploadId: string;
  /** The file keeps its own name on the host, in a folder of its own (a chat attachment). */
  keepName?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  /** The first chunk's size; later chunks grow or shrink to take about two seconds each. */
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
 * There is no size limit here: the host refuses a file only when it doesn't
 * fit in its free space.
 */
export async function uploadInChunks({
  invoke,
  file,
  sessionId,
  uploadId,
  keepName,
  signal,
  onProgress,
  chunkBytes = FIRST_CHUNK_BYTES,
  wait = sleep,
  now = Date.now,
}: UploadOptions): Promise<string> {
  let received = 0;
  let lastProgressAt = now();
  let failures = 0;
  let size = chunkBytes;
  const speed = speedometer(now);
  const report = (retrying: boolean) => onProgress?.({
    receivedBytes: received, totalBytes: file.size, retrying, lastProgressAt, secondsLeft: retrying ? null : speed.secondsLeft(file.size - received),
  });
  const call = (channel: string, args: JsonValue[]) => withTimeout(invoke(channel, args), CHUNK_TIMEOUT_MS);
  let stalled = false;
  let inFlightSince: number | null = null;
  let lastChunkMs: number | null = null;
  const moveTo = (bytes: number) => {
    if (bytes > received) lastProgressAt = now();
    // The speed before a stall says nothing about the speed after it.
    if (stalled) speed.restart(received);
    stalled = false;
    received = bytes;
    speed.record(bytes);
  };
  // A request that hangs (a dropped link the client hasn't noticed yet) shows as reconnecting, not as stale progress.
  const stallWatch = setInterval(() => {
    const limit = lastChunkMs === null ? FIRST_STALL_MS : Math.max(STALL_MS, lastChunkMs * STALL_FACTOR);
    if (stalled || inFlightSince === null || now() - inFlightSince < limit) return;
    stalled = true;
    report(true);
  }, 1000);

  try {
    let started = false;
    for (;;) {
      throwIfCancelled(signal);
      try {
        if (!started) {
          const request: JsonObject = { uploadId, sessionId, fileName: file.name, mimeType: file.mimeType, size: file.size, md5: file.md5 };
          if (keepName) request.keepName = true;
          const start = decodeBoundary(await call('terminal:upload-start', [request]), receivedSchema);
          started = true;
          speed.restart(start.receivedBytes);
          moveTo(start.receivedBytes);
          report(false);
        }
        while (received < file.size) {
          throwIfCancelled(signal);
          const sentAt = now();
          const data = await file.read(received, Math.min(size, file.size - received));
          inFlightSince = sentAt;
          const reply = decodeBoundary(await call('terminal:upload-chunk', [uploadId, received, data]), receivedSchema);
          inFlightSince = null;
          lastChunkMs = now() - sentAt;
          size = nextChunkBytes(size, lastChunkMs);
          moveTo(reply.receivedBytes);
          failures = 0;
          report(false);
        }
        throwIfCancelled(signal);
        const { filePath } = decodeBoundary(await call('terminal:upload-commit', [uploadId]), committedSchema);
        return filePath;
      } catch (error) {
        if (signal?.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No Pane daemon command registered')) throw new ChunkedUploadUnsupportedError(message);
        if (REFUSALS.test(message)) throw new UploadRefusedError(refusalText(message));
        // Ask the host where things stand, and start small again, before sending anything else.
        started = false;
        inFlightSince = null;
        stalled = false;
        size = chunkBytes;
        report(true);
        await wait(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 30000, signal);
        failures += 1;
      }
    }
    await invoke('terminal:upload-cancel', [uploadId]).catch(() => undefined);
    throw new Error('Upload cancelled');
  } finally {
    clearInterval(stallWatch);
  }
}

/** Doubles a chunk that came back fast and halves one that came back slow, within the bounds. */
function nextChunkBytes(current: number, elapsedMs: number): number {
  if (elapsedMs < TARGET_CHUNK_MS / 2) return Math.min(current * 2, MAX_CHUNK_BYTES);
  if (elapsedMs > TARGET_CHUNK_MS * 2) return Math.max(Math.floor(current / 2), MIN_CHUNK_BYTES);
  return current;
}

/** Bytes per second over the last SPEED_WINDOW_MS of this run. */
function speedometer(now: () => number) {
  let startedAt = now();
  let samples: { at: number; bytes: number }[] = [];
  return {
    restart(bytes: number) {
      startedAt = now();
      samples = [{ at: startedAt, bytes }];
    },
    record(bytes: number) {
      const at = now();
      samples.push({ at, bytes });
      while (samples.length > 2 && at - (samples[1]?.at ?? at) >= SPEED_WINDOW_MS) samples.shift();
    },
    secondsLeft(remaining: number): number | null {
      const first = samples[0];
      const last = samples.at(-1);
      if (!first || !last || last.at - startedAt < ESTIMATE_AFTER_MS || last.at <= first.at || last.bytes <= first.bytes) return null;
      const bytesPerSecond = (last.bytes - first.bytes) / ((last.at - first.at) / 1000);
      return Math.ceil(remaining / bytesPerSecond);
    },
  };
}

/** "about 3 min left", or null when the upload will be done in moments and a countdown would only flicker. */
export function formatTimeLeft(secondsLeft: number | null): string | null {
  if (secondsLeft === null || secondsLeft < 10) return null;
  if (secondsLeft < 60) return 'less than a minute left';
  const minutes = Math.round(secondsLeft / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ''} left`;
}

/** "88.1 MB", "1.2 GB": the units a person reads off their disk. */
export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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
