import { describe, expect, it, vi } from 'vitest';

import {
  ChunkedUploadUnsupportedError, formatTimeLeft, uploadInChunks, UploadRefusedError, uploadToHost, UPLOAD_NO_ROOM_MESSAGE,
  type UploadFile, type UploadProgress,
} from '../../../shared/chunkedUpload';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';

// The shared upload loop that the phone, desktop and the PWA all run.

const text = 'hello wonderful world';
const toBase64 = (value: string) => Buffer.from(value).toString('base64');

function memoryFile(content: string): UploadFile {
  return {
    name: 'note.txt',
    mimeType: 'text/plain',
    size: content.length,
    md5: 'md5-of-note',
    read: async (offset, length) => toBase64(content.slice(offset, offset + length)),
  };
}

/**
 * A host with the real protocol's rules: a chunk is appended only at the
 * current end, a repeat or a gap changes nothing, and every reply carries the
 * byte count. `failures` makes chosen calls fail like a dropped connection,
 * either before the host sees them or after it applied them (a lost reply).
 */
function fakeHost(failures: Record<number, 'before' | 'after'> = {}, refuse?: Error, onCall?: (channel: string, args: unknown[]) => void) {
  let received = '';
  let started = false;
  const calls: string[] = [];
  const invoke = async (channel: string, args: unknown[]) => {
    const index = calls.push(channel) - 1;
    onCall?.(channel, args);
    if (failures[index] === 'before') throw new Error('Network request failed');
    const reply = ((): JsonValue | undefined => {
      switch (channel) {
        case 'terminal:upload-start':
          if (refuse) throw refuse;
          started = true;
          return { receivedBytes: received.length };
        case 'terminal:upload-chunk': {
          // SAFETY: the upload loop sends chunks as [uploadId, offset, base64].
          const [, offset, data] = args as [string, number, string];
          if (!started) throw new Error('Upload not found. Start it again.');
          if (offset === received.length) received += Buffer.from(data, 'base64').toString();
          return { receivedBytes: received.length };
        }
        case 'terminal:upload-commit':
          return { filePath: `/host/.pane/files/${received.length}-bytes.txt` };
        case 'terminal:upload-cancel':
          received = '';
          return undefined;
        case 'terminal:paste-file':
          return { filePath: `/host/.pane/files/${String(args[2])}` };
        default:
          throw new Error(`unexpected ${channel}`);
      }
    })();
    if (failures[index] === 'after') throw new Error('Network request failed');
    return reply;
  };
  return { invoke, calls, received: () => received };
}

const noWait = async () => undefined;
/** A clock where each chunk takes `msPerChunk(bytes)`: the host's link speed. */
function slowLink(msPerChunk: (bytes: number) => number) {
  let time = 0;
  const sizes: number[] = [];
  const onCall = (channel: string, args: unknown[]) => {
    if (channel !== 'terminal:upload-chunk') return;
    const bytes = Buffer.from(String(args[2]), 'base64').length;
    sizes.push(bytes);
    time += msPerChunk(bytes);
  };
  return { now: () => time, onCall, sizes };
}

describe('uploadInChunks', () => {
  it('sends the file in chunks and returns the host path', async () => {
    const progress: UploadProgress[] = [];

    // Each chunk takes 1.5 s, close to the 2 s aim, so chunks keep their size.
    const link = slowLink(() => 1500);
    const host = fakeHost({}, undefined, link.onCall);
    const path = await uploadInChunks({
      invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1',
      chunkBytes: 8, wait: noWait, now: link.now, onProgress: update => progress.push(update),
    });

    expect(path).toBe('/host/.pane/files/21-bytes.txt');
    expect(host.received()).toBe(text);
    expect(host.calls).toEqual([
      'terminal:upload-start', 'terminal:upload-chunk', 'terminal:upload-chunk', 'terminal:upload-chunk', 'terminal:upload-commit',
    ]);
    expect(progress.map(update => update.receivedBytes)).toEqual([0, 8, 16, 21]);
  });

  it('survives a lost reply without sending a byte twice', async () => {
    // Call 2 is the second chunk: the host applies it, then the reply is lost.
    const host = fakeHost({ 2: 'after' });

    await uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 8, wait: noWait });

    expect(host.received()).toBe(text);
  });

  it('keeps retrying through an outage and resumes from what the host has', async () => {
    // The connection drops after the first chunk and stays down for three tries.
    const host = fakeHost({ 2: 'before', 3: 'before', 4: 'before' });
    const waits: number[] = [];
    const progress: UploadProgress[] = [];

    await uploadInChunks({
      invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 8, now: slowLink(() => 1500).now,
      wait: async ms => { waits.push(ms); },
      onProgress: update => progress.push(update),
    });

    expect(host.received()).toBe(text);
    expect(waits).toEqual([1000, 2000, 4000]);
    // Each retry asks the host where to resume before sending more.
    expect(host.calls.slice(3, 6)).toEqual(['terminal:upload-start', 'terminal:upload-start', 'terminal:upload-start']);
    expect(progress.some(update => update.retrying)).toBe(true);
    expect(progress.at(-1)?.retrying).toBe(false);
  });

  it('stops at once when the host has no room, by its error code', async () => {
    const message = `${UPLOAD_NO_ROOM_MESSAGE}: note.txt needs 1.0 GB, 5.5 GB is free, and Pane keeps 5.0 GB free (Settings > Machine health). Nothing was saved.`;
    // A phone or the PWA gets the code on the error; local desktop gets it in Electron's IPC text.
    for (const refusal of [new PaneError('ERR_UPLOAD_NO_ROOM', message), new Error(`Error [ERR_UPLOAD_NO_ROOM]: ${message} Next: Free up space here, or send a smaller file.`)]) {
      const host = fakeHost({}, refusal);

      await expect(uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
        .rejects.toBeInstanceOf(UploadRefusedError);
      expect(host.calls).toEqual(['terminal:upload-start']);
    }
  });

  it('stops at once when an older host refuses the file in words', async () => {
    const host = fakeHost({}, new Error('File too large (60 MB, max 50 MB)'));

    await expect(uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toThrow(new UploadRefusedError('File too large (60 MB, max 50 MB)'));
    expect(host.calls).toEqual(['terminal:upload-start']);
  });

  it('recognizes a refusal wrapped by the remote client', async () => {
    const wrapped = 'Delivery unknown: the remote action may have completed, but its result could not be confirmed. '
      + 'Check the current state before trying again. (Upload checksum mismatch)';
    const host = fakeHost({}, new Error(wrapped));

    await expect(uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toThrow(new UploadRefusedError('Upload checksum mismatch'));
  });

  it('reports a host without chunked upload instead of retrying', async () => {
    const host = fakeHost({}, new Error('No Pane daemon command registered for channel "terminal:upload-start"'));

    await expect(uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toBeInstanceOf(ChunkedUploadUnsupportedError);
    expect(host.calls).toEqual(['terminal:upload-start']);
  });

  it('sends a chat attachment to an older host in one request, from desktop connected to it', async () => {
    // Desktop's remote client rewrites the host's unknown-command error (remotePaneClient.ts hostOutdatedError).
    const outdated = new PaneError('ERR_HOST_OUTDATED', 'Old Mac runs an older Pane that does not have this command (terminal:upload-start). Nothing was changed.');
    const pastes: unknown[][] = [];
    const host = fakeHost({}, outdated, (channel, args) => { if (channel === 'terminal:paste-file') pastes.push(args); });

    const path = await uploadToHost({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', keepName: true, wait: noWait });

    expect(path).toBe('/host/.pane/files/note.txt');
    expect(pastes).toEqual([['s1', `data:text/plain;base64,${toBase64(text)}`, 'note.txt', { keepName: true }]]);
  });

  it('refuses a file over 12 MB for an older host, saying to update it', async () => {
    const host = fakeHost({}, new Error('No Pane daemon command registered for channel "terminal:upload-start"'));
    const big = { ...memoryFile(text), name: 'movie.mov', size: 13 * 1024 * 1024 };

    await expect(uploadToHost({ invoke: host.invoke, file: big, sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toThrow(new UploadRefusedError('The Pane on that computer takes files up to 12 MB, and movie.mov is larger. Update Pane there to send files of any size.'));
    expect(host.calls).toEqual(['terminal:upload-start']);
  });

  it('grows chunks on a fast link and shrinks them on a slow one', async () => {
    const content = 'x'.repeat(1000);
    // 50 ms per chunk until 300 bytes are in, then 10 s per chunk.
    let sent = 0;
    const link = slowLink(bytes => { sent += bytes; return sent <= 300 ? 50 : 10_000; });
    const host = fakeHost({}, undefined, link.onCall);

    await uploadInChunks({ invoke: host.invoke, file: memoryFile(content), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 20, now: link.now, wait: noWait });

    expect(host.received()).toBe(content);
    expect(link.sizes.slice(0, 5)).toEqual([20, 40, 80, 160, 320]);
    // Halved after each slow chunk, never below 64 KiB: the slow tail sends the rest at once.
    expect(link.sizes.slice(5)).toEqual([380]);
  });

  it('estimates the time left from the recent speed', async () => {
    const content = 'x'.repeat(100);
    // 10 bytes a second.
    const link = slowLink(bytes => bytes * 100);
    const host = fakeHost({}, undefined, link.onCall);
    const progress: UploadProgress[] = [];

    await uploadInChunks({
      invoke: host.invoke, file: memoryFile(content), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 10, now: link.now, wait: noWait,
      onProgress: update => progress.push(update),
    });

    const at30 = progress.find(update => update.receivedBytes === 30);
    expect(at30?.secondsLeft).toBe(7);
    expect(progress[0]?.secondsLeft).toBeNull();
  });

  it('asks the host to keep the file name when told to', async () => {
    const starts: unknown[] = [];
    const host = fakeHost({}, undefined, (channel, args) => { if (channel === 'terminal:upload-start') starts.push(args[0]); });

    await uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', keepName: true, wait: noWait });

    expect(starts).toEqual([expect.objectContaining({ fileName: 'note.txt', keepName: true })]);
  });

  it('shows a hanging request as reconnecting, then carries on when it answers', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      let release: () => void = () => undefined;
      let chunks = 0;
      // The second chunk hangs, as a request does when the link drops without the client noticing.
      const invoke = async (channel: string, args: unknown[]) => {
        if (channel === 'terminal:upload-chunk' && ++chunks === 2) await new Promise<void>(resolve => { release = resolve; });
        return host.invoke(channel, args);
      };
      const progress: UploadProgress[] = [];
      const run = uploadInChunks({ invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 8, wait: noWait, onProgress: update => progress.push(update) });

      // The first chunk took no time, so 10 s without an answer is a stall.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(progress.at(-1)?.retrying).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(progress.at(-1)).toMatchObject({ retrying: true, secondsLeft: null, receivedBytes: 8 });

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(await run).toBe('/host/.pane/files/21-bytes.txt');
      expect(progress.at(-1)?.retrying).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the host to discard the upload when cancelled', async () => {
    const host = fakeHost();
    const controller = new AbortController();

    const run = uploadInChunks({
      invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 8, wait: noWait,
      signal: controller.signal,
      onProgress: update => { if (update.receivedBytes === 8) controller.abort(); },
    });

    await expect(run).rejects.toThrow('Upload cancelled');
    expect(host.calls.at(-1)).toBe('terminal:upload-cancel');
    expect(host.calls).not.toContain('terminal:upload-commit');
  });

  it('tells the host to discard the upload when cancelled while reconnecting', async () => {
    // The second chunk's connection drops; the person cancels during the wait before the retry.
    const host = fakeHost({ 2: 'before' });
    const controller = new AbortController();

    const run = uploadInChunks({
      invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 8, signal: controller.signal,
      wait: async () => { controller.abort(); },
    });

    await expect(run).rejects.toThrow('Upload cancelled');
    expect(host.calls.at(-1)).toBe('terminal:upload-cancel');
  });
});

describe('formatTimeLeft', () => {
  it('says nothing for an upload about to finish, then minutes, then hours', () => {
    expect(formatTimeLeft(null)).toBeNull();
    expect(formatTimeLeft(4)).toBeNull();
    expect(formatTimeLeft(45)).toBe('less than a minute left');
    expect(formatTimeLeft(190)).toBe('about 3 min left');
    expect(formatTimeLeft(4800)).toBe('about 1 h 20 min left');
  });
});
