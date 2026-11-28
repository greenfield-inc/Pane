import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MoveReceiver, packageFile, sendFile, type ChunkSender } from './transfer';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-move-transfer-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function sha(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function through(receiver: MoveReceiver, faults: { failFirst?: number } = {}): ChunkSender & { calls: number; maxChunk: number } {
  let failures = faults.failFirst ?? 0;
  const sender = {
    calls: 0,
    maxChunk: 0,
    async write(request: Parameters<MoveReceiver['write']>[0]) {
      sender.calls += 1;
      sender.maxChunk = Math.max(sender.maxChunk, Buffer.from(request.content, 'base64').length);
      if (failures > 0) { failures -= 1; throw new Error('connection reset'); }
      return receiver.write(request);
    },
  };
  return sender;
}

describe('sendFile', () => {
  it('lands a file byte for byte and checks its digest', async () => {
    const content = Buffer.from('{"a":1}\n'.repeat(1000));
    const source = path.join(dir, 'conversation.jsonl');
    fs.writeFileSync(source, content);
    const receiver = new MoveReceiver(path.join(dir, 'staging'));
    const result = await sendFile(through(receiver), 'move-12345678', 'conversations/t1/a.jsonl', source);
    expect(result).toEqual({ path: 'conversations/t1/a.jsonl', bytes: content.length, sha256: sha(content) });
    expect(fs.readFileSync(receiver.filePath('move-12345678', 'conversations/t1/a.jsonl'))).toEqual(content);
  });

  it('sends a large file in chunks no larger than a machine write', async () => {
    const content = randomBytes(20 * 1024 * 1024);
    const source = path.join(dir, 'big.bin');
    fs.writeFileSync(source, content);
    const receiver = new MoveReceiver(path.join(dir, 'staging'));
    const sender = through(receiver);
    await sendFile(sender, 'move-12345678', 'big.bin', source, { chunkBytes: 4 * 1024 * 1024 });
    expect(sender.calls).toBeGreaterThan(4);
    expect(sender.maxChunk).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(sha(fs.readFileSync(receiver.filePath('move-12345678', 'big.bin')))).toBe(sha(content));
  });

  it('retries a chunk whose call failed', async () => {
    const source = path.join(dir, 'a.txt');
    fs.writeFileSync(source, 'hello');
    const receiver = new MoveReceiver(path.join(dir, 'staging'));
    await sendFile(through(receiver, { failFirst: 2 }), 'move-12345678', 'a.txt', source);
    expect(fs.readFileSync(receiver.filePath('move-12345678', 'a.txt'), 'utf8')).toBe('hello');
  });

  it('refuses a file whose content changed on the way', async () => {
    const source = path.join(dir, 'a.txt');
    fs.writeFileSync(source, 'hello');
    const receiver = new MoveReceiver(path.join(dir, 'staging'));
    const tampering: ChunkSender = {
      write: request => receiver.write(request.last ? { ...request, last: { ...request.last, sha256: '0'.repeat(64) } } : request),
    };
    await expect(sendFile(tampering, 'move-12345678', 'a.txt', source)).rejects.toThrow(/doesn't match/);
    expect(fs.existsSync(receiver.filePath('move-12345678', 'a.txt'))).toBe(false);
  });

  it('refuses a package path that climbs out of the staging folder', async () => {
    const receiver = new MoveReceiver(path.join(dir, 'staging'));
    await expect(receiver.write({ moveId: 'move-12345678', path: '../escape', offset: 0, content: '' })).rejects.toThrow(/package path/);
  });
});

describe('packageFile (#1762 F-2)', () => {
  it.skipIf(process.platform === 'win32')('marks an executable file, which the transfer alone would lose, and nothing else', async () => {
    const script = path.join(dir, 'run.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    const plain = path.join(dir, 'notes.md');
    fs.writeFileSync(plain, 'notes', { mode: 0o644 });
    expect(await packageFile('session/run.sh', script)).toEqual({ path: 'session/run.sh', bytes: 18, sha256: sha(fs.readFileSync(script)), executable: true });
    expect(await packageFile('session/notes.md', plain)).toEqual({ path: 'session/notes.md', bytes: 5, sha256: sha(Buffer.from('notes')) });
  });
});
