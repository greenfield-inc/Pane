import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputSequencer, parseInputSequenceHeader } from './inputSequencer';

afterEach(() => vi.useRealTimers());

async function write(sequencer: InputSequencer, log: string[], stream: string, seq: number, data: string, delayMs = 0): Promise<void> {
  const release = await sequencer.enter(stream, seq);
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  log.push(data);
  release();
}

describe('InputSequencer', () => {
  it('writes requests that arrive out of order in sequence order', async () => {
    const sequencer = new InputSequencer();
    const log: string[] = [];
    await Promise.all([
      write(sequencer, log, 's', 2, 'c'),
      write(sequencer, log, 's', 0, 'a', 5),
      write(sequencer, log, 's', 3, 'd'),
      write(sequencer, log, 's', 1, 'b'),
    ]);
    expect(log.join('')).toBe('abcd');
  });

  it('keeps streams independent', async () => {
    const sequencer = new InputSequencer();
    const log: string[] = [];
    await Promise.all([
      write(sequencer, log, 'one', 1, '1b'),
      write(sequencer, log, 'two', 0, '2a'),
      write(sequencer, log, 'one', 0, '1a'),
    ]);
    expect(log).toEqual(['2a', '1a', '1b']);
  });

  it('skips a request that never arrives after the gap timeout instead of stalling', async () => {
    vi.useFakeTimers();
    const sequencer = new InputSequencer(1_000);
    const log: string[] = [];
    const done = Promise.all([
      write(sequencer, log, 's', 0, 'a'),
      write(sequencer, log, 's', 2, 'c'),
      write(sequencer, log, 's', 3, 'd'),
    ]);
    await vi.advanceTimersByTimeAsync(999);
    expect(log).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(log).toEqual(['a', 'c', 'd']);
    // The late request is written when it finally shows up, never dropped.
    await write(sequencer, log, 's', 1, 'b');
    expect(log).toEqual(['a', 'c', 'd', 'b']);
  });

  it('does not strand a waiter when a sequence number repeats', async () => {
    const sequencer = new InputSequencer();
    const log: string[] = [];
    await Promise.all([
      write(sequencer, log, 's', 1, 'x'),
      write(sequencer, log, 's', 1, 'y'),
      write(sequencer, log, 's', 0, 'a'),
    ]);
    expect(log.sort()).toEqual(['a', 'x', 'y']);
  });

  it('parses only well-formed headers', () => {
    expect(parseInputSequenceHeader('abc-DEF_1:42')).toEqual({ stream: 'abc-DEF_1', seq: 42 });
    expect(parseInputSequenceHeader(['s:0'])).toEqual({ stream: 's', seq: 0 });
    for (const bad of [undefined, '', 's', 's:-1', 's:1.5', 'a b:1', `${'x'.repeat(65)}:1`, 's:1234567890']) {
      expect(parseInputSequenceHeader(bad)).toBeNull();
    }
  });
});
