import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteInputQueue } from '../../../../shared/remoteInputQueue';

afterEach(() => vi.useRealTimers());

describe('RemoteInputQueue lifecycle', () => {
  it('ignores late completions after cancellation when new input is already pending', async () => {
    const finish: Array<() => void> = [];
    const send = vi.fn((_channel: string, _args: unknown[], _signal?: AbortSignal) =>
      new Promise<void>(resolve => finish.push(resolve)));
    const queue = new RemoteInputQueue(send);
    const old = Promise.allSettled([
      queue.invoke('terminal:input', ['panel', 'old']),
      queue.invoke('terminal:input', ['panel', 'discard']),
    ]);
    queue.cancel(new Error('Disconnected'));
    const current = Promise.all([
      queue.invoke('terminal:input', ['panel', 'new']),
      queue.invoke('terminal:input', ['panel', 'suffix']),
    ]);
    finish[0]();
    await old;
    expect(send).toHaveBeenCalledTimes(2);
    finish[1]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]).toEqual(['terminal:input', ['panel', 'suffix'], expect.any(AbortSignal)]);
    finish[2]();
    await current;
  });

  it('aborts a stuck write and rejects pending input when its deadline expires', async () => {
    vi.useFakeTimers();
    const send = vi.fn((_channel: string, _args: unknown[], _signal?: AbortSignal) => new Promise<void>(() => {}));
    const queue = new RemoteInputQueue(send);
    const completed = Promise.allSettled([
      queue.invoke('terminal:input', ['panel', 'a']),
      queue.invoke('terminal:input', ['panel', 'b']),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await completed).every(result => result.status === 'rejected'
      && result.reason instanceof Error && result.reason.message.includes('timed out'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]?.aborted).toBe(true);
  });

  it('ends a combined batch at a bare Escape so the next key is not read as Alt+key', async () => {
    const finish: Array<() => void> = [];
    const send = vi.fn((_channel: string, _args: unknown[], _signal?: AbortSignal) =>
      new Promise<void>(resolve => finish.push(resolve)));
    const queue = new RemoteInputQueue(send);
    // Typed text, then Esc, more text, then Esc, Esc, Up while the first key is in flight.
    const completed = Promise.all(['a', 'b', '\x1b', 'c', '\x1b', '\x1b', '\x1b[A'].map(key =>
      queue.invoke('terminal:input', ['panel', key])));
    const expected = ['a', 'b\x1b', 'c\x1b', '\x1b', '\x1b[A'];
    for (const [index, data] of expected.entries()) {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(index + 1));
      expect(send.mock.calls[index][1]).toEqual(['panel', data]);
      finish[index]();
    }
    await completed;
    expect(send).toHaveBeenCalledTimes(expected.length);
  });

  it('bounds combined batches without splitting individual input events', async () => {
    const finish: Array<() => void> = [];
    const send = vi.fn((_channel: string, _args: unknown[], _signal?: AbortSignal) =>
      new Promise<void>(resolve => finish.push(resolve)));
    const queue = new RemoteInputQueue(send);
    const paste = 'x'.repeat(64 * 1024);
    const completed = Promise.all([
      queue.invoke('terminal:input', ['panel', 'a']),
      queue.invoke('terminal:input', ['panel', paste]),
      queue.invoke('terminal:input', ['panel', '\r']),
    ]);
    finish[0]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1]).toEqual(['panel', paste]);
    finish[1]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2][1]).toEqual(['panel', '\r']);
    finish[2]();
    await completed;
  });
});
