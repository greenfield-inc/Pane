import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChunkedUploadStore, type UploadRecord } from './chunkedUploadStore';

// MD5 of the ASCII text "hello world", from `printf 'hello world' | md5`.
const HELLO_WORLD_MD5 = '5eb63bbbe01eeed093cb22bb8f5acdc3';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const ID = 'upload-0001';

describe('ChunkedUploadStore', () => {
  let dir: string;
  let now: number;
  let store: ChunkedUploadStore;
  const saved: Array<{ record: UploadRecord; bytes: string }> = [];
  const save = async (record: UploadRecord, bytes: Buffer) => {
    saved.push({ record, bytes: bytes.toString() });
    return `/host/files/${record.fileName}`;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pane-uploads-'));
    now = 1_000_000;
    saved.length = 0;
    store = new ChunkedUploadStore({ dir, now: () => now });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const startHello = () => store.start({
    uploadId: ID,
    sessionId: 's1',
    fileName: 'hello.txt',
    mimeType: 'text/plain',
    size: 11,
    md5: HELLO_WORLD_MD5,
  });

  it('assembles chunks in order and commits the whole file once', async () => {
    expect(await startHello()).toEqual({ receivedBytes: 0 });
    expect(await store.append(ID, 0, b64('hello '))).toEqual({ receivedBytes: 6 });
    expect(await store.append(ID, 6, b64('world'))).toEqual({ receivedBytes: 11 });

    expect(await store.commit(ID, save)).toEqual({ filePath: '/host/files/hello.txt' });
    expect(saved).toEqual([{ record: expect.objectContaining({ sessionId: 's1', mimeType: 'text/plain' }), bytes: 'hello world' }]);
  });

  it('resumes from what the host already has', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello '));

    expect(await startHello()).toEqual({ receivedBytes: 6 });
  });

  it('ignores a chunk it already has, so a retried chunk is harmless', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello '));

    expect(await store.append(ID, 0, b64('hello '))).toEqual({ receivedBytes: 6 });
    await store.append(ID, 6, b64('world'));
    expect(await store.commit(ID, save)).toEqual({ filePath: '/host/files/hello.txt' });
    expect(saved[0]?.bytes).toBe('hello world');
  });

  it('drops a chunk past a gap and reports where to resume', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello '));

    expect(await store.append(ID, 8, b64('rld'))).toEqual({ receivedBytes: 6 });
    await store.append(ID, 6, b64('world'));
    expect(await store.commit(ID, save)).toEqual({ filePath: '/host/files/hello.txt' });
  });

  it('refuses files over 50 MB before any bytes move', async () => {
    await expect(store.start({ uploadId: ID, sessionId: 's1', fileName: 'big.mov', mimeType: 'video/quicktime', size: 60 * 1024 * 1024, md5: 'x' }))
      .rejects.toThrow('File too large (60 MB, max 50 MB)');
  });

  it('refuses to commit corrupted or incomplete bytes', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello '));
    await expect(store.commit(ID, save)).rejects.toThrow('Upload incomplete: 6 of 11 bytes received');

    await store.append(ID, 6, b64('wor1d'));
    await expect(store.commit(ID, save)).rejects.toThrow('Upload checksum mismatch');
    expect(saved).toEqual([]);
  });

  it('commits without a checksum when the phone could not compute one', async () => {
    await store.start({ uploadId: ID, sessionId: 's1', fileName: 'hello.txt', mimeType: 'text/plain', size: 11, md5: '' });
    await store.append(ID, 0, b64('hello world'));

    expect(await store.commit(ID, save)).toEqual({ filePath: '/host/files/hello.txt' });
  });

  it('returns the same path when commit is repeated', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello world'));
    await store.commit(ID, save);

    expect(await store.commit(ID, save)).toEqual({ filePath: '/host/files/hello.txt' });
    expect(saved).toHaveLength(1);
  });

  it('leaves nothing behind after cancel', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello '));
    await store.cancel(ID);

    expect(await readdir(dir)).toEqual([]);
    await expect(store.append(ID, 6, b64('world'))).rejects.toThrow('Upload not found');
  });

  it('deletes uploads untouched for a day when the next upload starts', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello '));

    now += 25 * 60 * 60 * 1000;
    await store.start({ uploadId: 'upload-0002', sessionId: 's1', fileName: 'b.txt', mimeType: 'text/plain', size: 1, md5: 'x' });

    expect((await readdir(dir)).sort()).toEqual(['upload-0002.json', 'upload-0002.part']);
  });
});
