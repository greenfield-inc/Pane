import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunpaneLockOwner } from '../../../shared/types/runpaneOrchestration';
import { NamedLockService } from './namedLockService';
import { NamedLockStore } from './namedLockStore';

const workerA: RunpaneLockOwner = { kind: 'pane', paneId: 'pane-a', panelId: 'panel-a' };
const workerB: RunpaneLockOwner = { kind: 'pane', paneId: 'pane-b', panelId: 'panel-b' };
const human: RunpaneLockOwner = { kind: 'external', label: 'Tyler running call QA' };
const MINUTE = 60_000;

const temporaryDirectories: string[] = [];
const services: NamedLockService[] = [];

function createStorePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-named-locks-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'locks.json');
}

function createService(filePath = createStorePath(), isOwnerLive?: (owner: RunpaneLockOwner) => boolean): NamedLockService {
  const service = new NamedLockService(new NamedLockStore(filePath), { isOwnerLive });
  services.push(service);
  return service;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
});

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('NamedLockService', () => {
  it('grants a free lock and refuses a second owner with the holder and expiry', async () => {
    const locks = createService();
    const first = await locks.acquire({ name: 'testing-account', ttlMs: 30 * MINUTE, note: 'call QA', owner: workerA });
    expect(first).toMatchObject({
      ok: true,
      acquired: true,
      renewed: false,
      lock: {
        name: 'testing-account',
        scope: 'global',
        owner: workerA,
        note: 'call QA',
        acquiredAt: '2026-09-27T12:00:00.000Z',
        expiresAt: '2026-09-27T12:30:00.000Z',
      },
    });

    const second = await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerB });
    expect(second).toMatchObject({
      ok: false,
      acquired: false,
      timedOut: false,
      heldBy: workerA,
      expiresAt: '2026-09-27T12:30:00.000Z',
    });
  });

  it('renews the TTL when the same owner acquires again', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: 10 * MINUTE, owner: workerA });
    vi.advanceTimersByTime(5 * MINUTE);

    const renewed = await locks.acquire({ name: 'testing-account', ttlMs: 10 * MINUTE, owner: workerA });
    expect(renewed).toMatchObject({
      ok: true,
      renewed: true,
      lock: { acquiredAt: '2026-09-27T12:00:00.000Z', expiresAt: '2026-09-27T12:15:00.000Z' },
    });
  });

  it('treats another panel in the same Pane as a different owner', async () => {
    const locks = createService();
    await locks.acquire({ name: 'db', ttlMs: MINUTE, owner: workerA });
    const sibling = await locks.acquire({ name: 'db', ttlMs: MINUTE, owner: { ...workerA, panelId: 'panel-a2' } });
    expect(sibling.ok).toBe(false);
  });

  it('expires a lock after its TTL and lets the next owner take it', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerA });
    vi.advanceTimersByTime(MINUTE);

    expect(locks.list()).toEqual([]);
    const next = await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerB });
    expect(next).toMatchObject({ ok: true, renewed: false, lock: { owner: workerB } });
  });

  it('rejects release by a non-owner unless forced', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerA });

    expect(locks.release({ name: 'testing-account', owner: workerB })).toMatchObject({
      ok: false,
      released: false,
      reason: 'not-owner',
      heldBy: workerA,
    });
    expect(locks.list()).toHaveLength(1);

    expect(locks.release({ name: 'testing-account', owner: workerB, force: true })).toMatchObject({
      ok: true,
      released: true,
      forced: true,
      lock: { owner: workerA },
    });
    expect(locks.list()).toEqual([]);
  });

  it('releases an owned lock and reports a lock that was not held', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: human });

    expect(locks.release({ name: 'testing-account', owner: human })).toMatchObject({ ok: true, released: true, forced: false });
    expect(locks.release({ name: 'testing-account', owner: human })).toEqual({ ok: true, released: false, forced: false });
  });

  it('wakes a waiting acquire the moment the holder releases', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: 30 * MINUTE, owner: workerA });
    const waiting = locks.acquire({ name: 'testing-account', ttlMs: 10 * MINUTE, waitMs: 5 * MINUTE, owner: workerB });

    vi.advanceTimersByTime(2 * MINUTE);
    locks.release({ name: 'testing-account', owner: workerA });

    await expect(waiting).resolves.toMatchObject({
      ok: true,
      acquired: true,
      waitedMs: 2 * MINUTE,
      lock: { owner: workerB, expiresAt: '2026-09-27T12:12:00.000Z' },
    });
  });

  it('wakes a waiting acquire when the holder expires, oldest waiter first', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerA });
    const firstWaiter = locks.acquire({ name: 'testing-account', ttlMs: MINUTE, waitMs: 10 * MINUTE, owner: workerB });
    const secondWaiter = locks.acquire({ name: 'testing-account', ttlMs: MINUTE, waitMs: 10 * MINUTE, owner: human });

    vi.advanceTimersByTime(MINUTE);
    await expect(firstWaiter).resolves.toMatchObject({ ok: true, lock: { owner: workerB } });

    vi.advanceTimersByTime(MINUTE);
    await expect(secondWaiter).resolves.toMatchObject({ ok: true, lock: { owner: human }, waitedMs: 2 * MINUTE });
  });

  it.each(['panel', 'pane'] as const)('cancels a waiting acquire when its %s owner leaves', async scope => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerA });
    const waiting = locks.acquire({ name: 'testing-account', ttlMs: MINUTE, waitMs: MINUTE, owner: workerB });
    const cancelled = expect(waiting).rejects.toThrow('owner exited or was archived');
    if (scope === 'panel') locks.releaseOwnedByPanel(workerB.panelId!);
    else locks.send('session:deleted', { id: workerB.paneId! });
    await cancelled;
    locks.release({ name: 'testing-account', owner: workerA });
    expect(locks.list()).toEqual([]);
  });

  it('gives up a wait when it runs out and reports the holder', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: 30 * MINUTE, owner: workerA });
    const waiting = locks.acquire({ name: 'testing-account', ttlMs: MINUTE, waitMs: 2 * MINUTE, owner: workerB });

    vi.advanceTimersByTime(2 * MINUTE);
    await expect(waiting).resolves.toMatchObject({ ok: false, timedOut: true, waitedMs: 2 * MINUTE, heldBy: workerA });

    locks.release({ name: 'testing-account', owner: workerA });
    expect(locks.list()).toEqual([]);
  });

  it('releases a panel owner\'s locks when its terminal exits', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: 30 * MINUTE, owner: workerA });
    await locks.acquire({ name: 'staging-db', ttlMs: 30 * MINUTE, owner: workerB });
    const waiting = locks.acquire({ name: 'testing-account', ttlMs: MINUTE, waitMs: 5 * MINUTE, owner: workerB });

    locks.send('panel:event', {
      type: 'terminal:exit',
      source: { panelId: 'panel-a', sessionId: 'pane-a', panelType: 'terminal' },
      data: { exitCode: 0 },
    });

    await expect(waiting).resolves.toMatchObject({ ok: true, lock: { owner: workerB } });
    expect(locks.list().map(lock => lock.name)).toEqual(['staging-db', 'testing-account']);
  });

  it('releases every lock a Pane holds when the Pane is archived', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: 30 * MINUTE, owner: workerA });
    await locks.acquire({ name: 'pane-wide', ttlMs: 30 * MINUTE, owner: { kind: 'pane', paneId: 'pane-a' } });
    await locks.acquire({ name: 'staging-db', ttlMs: 30 * MINUTE, owner: workerB });

    locks.send('session:deleted', { id: 'pane-a' });

    expect(locks.list().map(lock => lock.name)).toEqual(['staging-db']);
  });

  it('ignores owner exits while Pane is shutting down', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: 30 * MINUTE, owner: workerA });

    locks.suspendAutoRelease();
    locks.send('panel:event', { type: 'terminal:exit', source: { panelId: 'panel-a', sessionId: 'pane-a' }, data: {} });
    locks.send('session:deleted', { id: 'pane-a' });

    expect(locks.list()).toHaveLength(1);
  });

  it('scopes locks to a Session so two Sessions can hold the same name', async () => {
    const locks = createService();
    const first = await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerA, sessionId: 'session-1' });
    const second = await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerB, sessionId: 'session-2' });
    const global = await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: human });
    const contended = await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerB, sessionId: 'session-1' });

    expect(first).toMatchObject({ ok: true, lock: { scope: 'session', sessionId: 'session-1' } });
    expect(second).toMatchObject({ ok: true, lock: { scope: 'session', sessionId: 'session-2' } });
    expect(global).toMatchObject({ ok: true, lock: { scope: 'global' } });
    expect(contended).toMatchObject({ ok: false, heldBy: workerA });

    expect(locks.list({ sessionId: 'session-1', paneIds: [] }).map(lock => lock.owner)).toEqual([workerA]);
    expect(locks.list({ sessionId: 'session-9', paneIds: ['pane-b'] }).map(lock => lock.sessionId)).toEqual(['session-2']);
  });

  it('lets an owner release a lock taken before its Pane joined a Session', async () => {
    const locks = createService();
    await locks.acquire({ name: 'testing-account', ttlMs: MINUTE, owner: workerA });

    expect(locks.release({ name: 'testing-account', owner: workerA, sessionId: 'session-1' })).toMatchObject({ ok: true, released: true });
  });

  it('survives a restart: saved locks reload and expired ones are pruned', async () => {
    const filePath = createStorePath();
    const before = createService(filePath);
    await before.acquire({ name: 'short', ttlMs: MINUTE, owner: workerA });
    await before.acquire({ name: 'long', ttlMs: 30 * MINUTE, owner: workerA, sessionId: 'session-1', note: 'call QA' });
    await before.acquire({ name: 'external', ttlMs: 30 * MINUTE, owner: human });
    before.dispose();

    vi.advanceTimersByTime(2 * MINUTE);
    const after = createService(filePath);
    expect(after.list()).toEqual([
      expect.objectContaining({ name: 'external', owner: human, scope: 'global' }),
      expect.objectContaining({ name: 'long', owner: workerA, scope: 'session', sessionId: 'session-1', note: 'call QA' }),
    ]);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(saved).toMatchObject({ version: 1 });
    expect(saved.locks.map((lock: { name: string }) => lock.name).sort()).toEqual(['external', 'long']);
  });

  it('drops saved locks whose owner Pane is gone when it loads', async () => {
    const filePath = createStorePath();
    const before = createService(filePath);
    await before.acquire({ name: 'kept', ttlMs: 30 * MINUTE, owner: workerB });
    await before.acquire({ name: 'orphaned', ttlMs: 30 * MINUTE, owner: workerA });
    before.dispose();

    const after = createService(filePath, owner => owner.paneId !== 'pane-a');
    expect(after.list().map(lock => lock.name)).toEqual(['kept']);
  });

  it('refuses a corrupt store instead of silently dropping locks', async () => {
    const filePath = createStorePath();
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, locks: [{ name: 'bad name!' }] }));
    const locks = createService(filePath);
    expect(() => locks.list()).toThrow(/Unable to read named lock store/);
  });

  it('validates names, TTLs, and notes', async () => {
    const locks = createService();
    expect(() => locks.acquire({ name: 'has space', ttlMs: MINUTE, owner: workerA })).toThrow(/Lock names/);
    expect(() => locks.acquire({ name: 'x'.repeat(129), ttlMs: MINUTE, owner: workerA })).toThrow(/Lock names/);
    expect(() => locks.acquire({ name: 'ok', ttlMs: 0, owner: workerA })).toThrow(/TTL/);
    expect(() => locks.acquire({ name: 'ok', ttlMs: 25 * 60 * MINUTE, owner: workerA })).toThrow(/TTL/);
    expect(() => locks.acquire({ name: 'ok', ttlMs: MINUTE, note: 'n'.repeat(501), owner: workerA })).toThrow(/notes/);
    await expect(locks.acquire({ name: 'x'.repeat(128), ttlMs: MINUTE, owner: workerA })).resolves.toMatchObject({ ok: true });
  });
});
