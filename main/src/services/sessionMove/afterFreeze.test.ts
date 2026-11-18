import { describe, expect, it } from 'vitest';
import { settleAfterFreeze, type FreezeTarget, type FreezeWait } from './afterFreeze';
import type { TargetStatus } from './importer';

/**
 * The source after the freeze, against a scripted target: it finishes or releases only on the
 * target's decision, and stays frozen on anything else (F-10, J9).
 */

const at = (stage: TargetStatus['stage'], extra: Partial<TargetStatus> = {}): TargetStatus => ({ moveId: 'm-1', stage, panesDone: 0, panesTotal: 0, durable: true, ...extra });

/** A target whose answers come from `script`, one per status call; the last repeats. */
function scripted(script: Array<TargetStatus | Error>, handlers: Partial<Pick<FreezeTarget, 'start' | 'rollBack'>> = {}) {
  const calls: string[] = [];
  let index = 0;
  const target: FreezeTarget = {
    status: async () => {
      calls.push('status');
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    start: async () => { calls.push('start'); return handlers.start ? handlers.start() : at('starting'); },
    rollBack: async () => { calls.push('rollBack'); return handlers.rollBack ? handlers.rollBack() : at('aborted', { rolledBack: true }); },
  };
  return { target, calls };
}

function hooks(limit = 50) {
  const waits: FreezeWait[] = [];
  let rounds = 0;
  return {
    waits,
    hooks: { onWait: (wait: FreezeWait) => { waits.push(wait); }, stopped: () => (rounds += 1) > limit, sleep: async () => undefined },
  };
}

describe('settleAfterFreeze', () => {
  it('a lost start: the target still says built, so the source asks again and the move completes', async () => {
    // The first start never arrived; status works and says built until the resent start lands.
    let started = false;
    const { target, calls } = scripted([at('built')], { start: async () => { started = true; return at('starting'); } });
    target.status = async () => { calls.push('status'); return started ? at('started', { resumed: 2 }) : at('built'); };
    const outcome = await settleAfterFreeze(target, hooks().hooks);
    expect(outcome).toEqual({ kind: 'committed', status: at('started', { resumed: 2 }) });
    expect(calls).toEqual(['status', 'start', 'status']);
  });

  it('the target restarted and recorded a roll-back: the source is released', async () => {
    const { target } = scripted([new Error('connection reset'), at('aborted', { rolledBack: true })]);
    const outcome = await settleAfterFreeze(target, hooks().hooks);
    expect(outcome?.kind).toBe('rolledBack');
  });

  it('a target with a durable record and none for this move is asked to fence it, then the source is released', async () => {
    const { target, calls } = scripted([at('aborted')]);
    const outcome = await settleAfterFreeze(target, hooks().hooks);
    expect(outcome?.kind).toBe('rolledBack');
    expect(calls).toEqual(['status', 'rollBack']);
  });

  it('a target that refuses the roll-back because the move committed is never released', async () => {
    const { target } = scripted([at('aborted')], { rollBack: async () => { throw new Error('already started'); } });
    const { hooks: wait, waits } = hooks(5);
    expect(await settleAfterFreeze(target, wait)).toBeUndefined();
    expect(waits.every(item => item.kind === 'unknown')).toBe(true);
  });

  it('an unreachable target keeps the source frozen, however long it lasts', async () => {
    const { target, calls } = scripted([new Error('timed out')]);
    const { hooks: wait, waits } = hooks(40);
    expect(await settleAfterFreeze(target, wait)).toBeUndefined();
    expect(calls.every(call => call === 'status')).toBe(true);
    expect(waits.length).toBeGreaterThan(30);
    expect(waits.every(item => item.kind === 'unreachable')).toBe(true);
  });

  it('an older target that has no record (no durable ledger) is unknown: frozen, never rolled back', async () => {
    const { target, calls } = scripted([at('aborted', { durable: undefined, error: { message: 'no record', next: 'x' } })]);
    const { hooks: wait, waits } = hooks(5);
    expect(await settleAfterFreeze(target, wait)).toBeUndefined();
    expect(calls).not.toContain('rollBack');
    expect(waits.at(-1)?.kind).toBe('unknown');
  });

  it('a start that failed before any tab started waits for Check again, frozen', async () => {
    const { target, calls } = scripted([at('failed', { retryable: true })]);
    const { hooks: wait, waits } = hooks(5);
    expect(await settleAfterFreeze(target, wait)).toBeUndefined();
    expect(calls).not.toContain('start');
    expect(waits.at(-1)?.kind).toBe('startFailed');
  });

  it('a source that restarted mid-commit resumes: the target already started, so it retires at once', async () => {
    const { target, calls } = scripted([at('started', { resumed: 1 })]);
    expect((await settleAfterFreeze(target, hooks().hooks))?.kind).toBe('committed');
    expect(calls).toEqual(['status']);
  });
});
