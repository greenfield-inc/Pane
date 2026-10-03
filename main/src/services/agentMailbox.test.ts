import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentMailbox } from './agentMailbox';

// Vite 5 predates node:sqlite; load the native builtin without its resolver.
// SAFETY: Node owns the node:sqlite builtin; this is its published module type.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  const mailbox = new AgentMailbox(db);
  cleanup.push(() => { mailbox.dispose(); db.close(); });
  return mailbox;
}

describe('durable agent mailbox', () => {
  it('claims the specifically woken task without consuming an older queued task', () => {
    const box = setup();
    box.send('task-a', 'sender', 'worker', 'Older task');
    box.send('task-b', 'sender', 'worker', 'Requested task');
    box.attemptWake('task-b', 'sender');
    expect(box.inbox('worker', true, false, 1, 'task-b')).toMatchObject([{ id: 'task-b', status: 'received' }]);
    expect(box.get('task-a').status).toBe('queued');
    expect(box.inbox('worker', true, false, 1, 'task-b')).toEqual([]);
    expect(() => box.inbox('stranger', true, false, 1, 'task-a')).toThrow('different recipient');
  });

  it('deduplicates exact sends, rejects conflicting reuse, and commits before observation', () => {
    const box = setup();
    expect(box.send('task-1', 'sender', 'worker', 'Implement issue')).toMatchObject({ duplicate: false });
    expect(box.send('task-1', 'sender', 'worker', 'Implement issue')).toMatchObject({ duplicate: true });
    expect(() => box.send('task-1', 'sender', 'other', 'Implement issue')).toThrow('different');
    expect(() => box.send('task-1', 'sender', 'worker', 'Different task')).toThrow('different');
    expect(box.inbox('worker', false)).toHaveLength(1);
  });

  it('persists receipts, replies and uncertain wake attempts across a restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-mailbox-test-'));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'sessions.db');
    const db = new DatabaseSync(filename);
    const first = new AgentMailbox(db);
    first.register('worker', 'any future agent');
    first.send('task-1', 'sender', 'worker', 'Task');
    first.attemptWake('task-1', 'sender');
    first.inbox('worker', true);
    first.dispose(); db.close();
    const second = setup(filename);
    expect(second.inbox('worker', true)).toEqual([]);
    expect(second.inbox('worker', false, true)[0]).toMatchObject({ status: 'received', wake: 'attempted' });
    expect(() => second.attemptWake('task-1', 'sender')).toThrow('already');
    second.reply('task-1', 'worker', 'completed', 'Commit abc; tests passed');
    const third = setup(filename);
    expect(third.get('task-1')).toMatchObject({ status: 'completed', revision: 3 });
    expect(third.peers()[0].agent).toBe('any future agent');
  });

  it('lets only one concurrent inbox consumer claim a message', async () => {
    const box = setup();
    const consumers = [box.waitInbox('worker', true, false, 1, 30), box.waitInbox('worker', true, false, 1, 30)];
    box.send('task-1', 'sender', 'worker', 'Task');
    const results = await Promise.all(consumers);
    expect(results.flatMap(result => result.messages)).toHaveLength(1);
    expect(results.filter(result => result.timedOut)).toHaveLength(1);
  });

  it('ignores queued/received notifications and wakes only for the correlated reply', async () => {
    const box = setup();
    box.send('task-1', 'sender', 'worker', 'Task');
    box.send('task-2', 'sender', 'other', 'Other task');
    const waiting = box.wait('task-1', 'sender', 0, 1000);
    box.inbox('worker', true);
    box.inbox('other', true);
    box.reply('task-2', 'other', 'completed', 'Unrelated result');
    expect(await box.wait('task-1', 'sender', 0, 1)).toMatchObject({ timedOut: true });
    box.reply('task-1', 'worker', 'blocked', 'Need user decision');
    const result = await waiting;
    expect(result).toMatchObject({ timedOut: false, message: { status: 'blocked', revision: 3 } });
    expect(await box.wait('task-1', 'sender', 3, 1)).toMatchObject({ timedOut: true });
    box.reply('task-1', 'worker', 'completed', 'Decision resolved; done');
    expect(await box.wait('task-1', 'sender', 3, 0)).toMatchObject({ timedOut: false, message: { revision: 4 } });
  });

  it('requires a receipt and the expected recipient, and keeps terminal results immutable', () => {
    const box = setup();
    box.send('task-1', 'sender', 'worker', 'Task');
    expect(() => box.reply('task-1', 'worker', 'completed', 'Done')).toThrow('Claim');
    box.inbox('worker', true);
    expect(() => box.reply('task-1', 'wrong-worker', 'completed', 'Done')).toThrow('recipient');
    const result = box.reply('task-1', 'worker', 'failed', 'Tests failed');
    expect(box.reply('task-1', 'worker', 'failed', 'Tests failed')).toEqual(result);
    expect(() => box.reply('task-1', 'worker', 'completed', 'Actually done')).toThrow('immutable');
  });

  it('rejects malformed ids, oversized payloads, replay claims and unauthorized waits', async () => {
    const box = setup();
    expect(() => box.send('../bad', 'sender', 'worker', 'Task')).toThrow('message id');
    expect(() => box.send('task-1', 'sender', 'worker', '界'.repeat(12000))).toThrow('32768');
    box.send('task-1', 'sender', 'worker', 'Task');
    expect(() => box.inbox('worker', true, true)).toThrow('Recovery');
    expect(() => box.inbox('worker', false, false, 101)).toThrow('limit');
    await expect(box.wait('task-1', 'stranger', 0, 1)).rejects.toThrow('participant');
    await expect(box.wait('task-1', 'sender', -1, 1)).rejects.toThrow('after');
    await expect(box.wait('task-1', 'sender', 0, 120001)).rejects.toThrow('timeout');
  });

  it('bounds waiters and closes them on shutdown', async () => {
    const box = setup();
    box.send('task-1', 'sender', 'worker', 'Task');
    const results = Promise.allSettled(Array.from({ length: 64 }, () => box.wait('task-1', 'sender')));
    await expect(box.wait('task-1', 'sender')).rejects.toThrow('Too many');
    box.dispose();
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
  });

  it('expires advertised native receivers without deleting durable identity', () => {
    const db = new DatabaseSync(':memory:');
    let now = 1000;
    const box = new AgentMailbox(db, () => now);
    cleanup.push(() => { box.dispose(); db.close(); });
    box.register('arbitrary-agent', 'custom', 'pi');
    expect(box.peers()[0].online).toBe(true);
    now += 120001;
    expect(box.peers()[0].online).toBe(false);
    box.touch('arbitrary-agent');
    expect(box.peers()[0].online).toBe(false);
    box.register('arbitrary-agent', 'custom', 'pi');
    expect(box.peers()[0].online).toBe(true);
  });
});
