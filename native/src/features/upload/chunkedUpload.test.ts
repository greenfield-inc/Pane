import { describe, expect, it } from 'vitest';

import { ChunkedUploadUnsupportedError, uploadInChunks, UploadRefusedError, type UploadFile, type UploadProgress } from './chunkedUpload';

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
function fakeHost(failures: Record<number, 'before' | 'after'> = {}, refuse?: string) {
  let received = '';
  let started = false;
  const calls: string[] = [];
  const invoke = async (channel: string, args: unknown[]) => {
    const index = calls.push(channel) - 1;
    if (failures[index] === 'before') throw new Error('Network request failed');
    const reply = (() => {
      switch (channel) {
        case 'terminal:upload-start':
          if (refuse) throw new Error(refuse);
          started = true;
          return { receivedBytes: received.length };
        case 'terminal:upload-chunk': {
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

describe('uploadInChunks', () => {
  it('sends the file in chunks and returns the host path', async () => {
    const host = fakeHost();
    const progress: UploadProgress[] = [];

    const path = await uploadInChunks({
      invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1',
      chunkBytes: 8, wait: noWait, onProgress: update => progress.push(update),
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
      invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', chunkBytes: 8,
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

  it('stops at once when the host refuses the file', async () => {
    const host = fakeHost({}, 'File too large (60 MB, max 50 MB)');

    await expect(uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toThrow(new UploadRefusedError('File too large (60 MB, max 50 MB)'));
    expect(host.calls).toEqual(['terminal:upload-start']);
  });

  it('recognizes a refusal wrapped by the remote client', async () => {
    const wrapped = 'The remote action may have completed, but its result could not be confirmed. '
      + 'Check the current state before trying again. (Upload checksum mismatch)';
    const host = fakeHost({}, wrapped);

    await expect(uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toThrow(new UploadRefusedError('Upload checksum mismatch'));
  });

  it('reports a host without chunked upload instead of retrying', async () => {
    const host = fakeHost({}, 'No Pane daemon command registered for channel "terminal:upload-start"');

    await expect(uploadInChunks({ invoke: host.invoke, file: memoryFile(text), sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toBeInstanceOf(ChunkedUploadUnsupportedError);
    expect(host.calls).toEqual(['terminal:upload-start']);
  });

  it('refuses a file over 50 MB before contacting the host', async () => {
    const host = fakeHost();
    const big = { ...memoryFile(text), size: 60 * 1024 * 1024 };

    await expect(uploadInChunks({ invoke: host.invoke, file: big, sessionId: 's1', uploadId: 'upload-1', wait: noWait }))
      .rejects.toThrow('File too large (60 MB, max 50 MB)');
    expect(host.calls).toEqual([]);
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
});
