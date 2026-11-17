import { mkdtemp, readdir, readFile, rename, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChunkedUploadStore, type UploadRecord } from './chunkedUploadStore';

// MD5 of the ASCII text "hello world", from `printf 'hello world' | md5`.
const HELLO_WORLD_MD5 = '5eb63bbbe01eeed093cb22bb8f5acdc3';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const ID = 'upload-0001';
const GB = 1024 ** 3;

describe('ChunkedUploadStore', () => {
  let dir: string;
  let now: number;
  let store: ChunkedUploadStore;
  let freeBytes: number | null;
  const saved: Array<{ record: UploadRecord; bytes: string }> = [];
  // Moves the finished file out, as the host's landing code does.
  const save = async (record: UploadRecord, filePath: string) => {
    const landed = path.join(dir, `landed-${saved.length}`);
    await rename(filePath, landed);
    saved.push({ record, bytes: await readFile(landed, 'utf8') });
    return `/host/files/${record.fileName}`;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pane-uploads-'));
    now = 1_000_000;
    saved.length = 0;
    freeBytes = 100 * GB;
    store = new ChunkedUploadStore({ dir, now: () => now, freeBytes: async () => freeBytes, reserveBytes: () => 5 * GB });
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

  it('takes a file of any size the host has room for', async () => {
    freeBytes = 7 * GB;
    await expect(store.start({ uploadId: ID, sessionId: 's1', fileName: 'big.mov', mimeType: 'video/quicktime', size: GB, md5: '' }))
      .resolves.toEqual({ receivedBytes: 0 });
  });

  it('refuses a file that would leave less than the reserve free, saying how much space there is', async () => {
    freeBytes = 5.5 * GB;
    await expect(store.start({ uploadId: ID, sessionId: 's1', fileName: 'big.mov', mimeType: 'video/quicktime', size: GB, md5: '' }))
      .rejects.toThrow('File too large for the free space on this computer: big.mov needs 1 GB, 5.5 GB is free, and Pane keeps 5 GB free. Free up space here, or send a smaller file.');
    expect(await readdir(dir)).toEqual([]);
  });

  it('counts only the bytes still to come when an upload resumes', async () => {
    await startHello();
    await store.append(ID, 0, b64('hello '));
    freeBytes = 5 * GB + 5;

    expect(await startHello()).toEqual({ receivedBytes: 6 });
  });

  it('takes the file when the host cannot read its free space', async () => {
    freeBytes = null;
    expect(await startHello()).toEqual({ receivedBytes: 0 });
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
