import { describe, expect, it } from 'vitest';
import { IdempotencyWindow, isValidIdempotencyKey } from './runpaneIdempotency';

describe('IdempotencyWindow', () => {
  it('runs a key once and returns the first result to repeats, even concurrent ones', async () => {
    const window = new IdempotencyWindow<number>();
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const task = async () => { runs += 1; await gate; return runs; };

    const first = window.run('k', task);
    const concurrent = window.run('k', task);
    release();
    await expect(first).resolves.toEqual({ result: 1, deduplicated: false });
    await expect(concurrent).resolves.toEqual({ result: 1, deduplicated: true });
    await expect(window.run('k', task)).resolves.toEqual({ result: 1, deduplicated: true });
    expect(runs).toBe(1);
  });

  it('forgets a key after the window, after a throw, or when told it sent nothing', async () => {
    let now = 0;
    const window = new IdempotencyWindow<string>(1000, 10, () => now);
    await window.run('a', async () => 'first');
    now = 1001;
    await expect(window.run('a', async () => 'second')).resolves.toEqual({ result: 'second', deduplicated: false });

    await expect(window.run('b', async () => { throw new Error('not initialized'); })).rejects.toThrow('not initialized');
    await expect(window.run('b', async () => 'retry')).resolves.toEqual({ result: 'retry', deduplicated: false });

    await window.run('c', async () => 'blocked', () => false);
    await expect(window.run('c', async () => 'sent')).resolves.toEqual({ result: 'sent', deduplicated: false });
  });

  it('bounds the number of remembered keys', async () => {
    const window = new IdempotencyWindow<string>(60_000, 2);
    await window.run('a', async () => 'a1');
    await window.run('b', async () => 'b1');
    await window.run('c', async () => 'c1');
    await expect(window.run('a', async () => 'a2')).resolves.toEqual({ result: 'a2', deduplicated: false });
    await expect(window.run('c', async () => 'c2')).resolves.toEqual({ result: 'c1', deduplicated: true });
  });

  it('validates key shape', () => {
    expect(isValidIdempotencyKey('client-1:abc.DEF_9')).toBe(true);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('has space')).toBe(false);
    expect(isValidIdempotencyKey('x'.repeat(257))).toBe(false);
  });
});
