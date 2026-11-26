import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteInputQueue } from '../../../../shared/remoteInputQueue';

afterEach(() => vi.useRealTimers());

describe('RemoteInputQueue lifecycle', () => {
  it('delivers typed keys in order when each request takes a different time to arrive', async () => {
    vi.useFakeTimers();
    // High-latency link: the first request is slowest, later ones overtake it
    // unless the queue holds them back.
    const latencies = [300, 50, 200, 10, 120];
    let host = '';
    let requestCount = 0;
    const send = vi.fn((_channel: string, args: unknown[]) => {
      const latency = latencies[requestCount++ % latencies.length];
      return new Promise<void>(resolve => setTimeout(() => {
        host += String(args[1]);
        resolve();
      }, latency));
    });
    const queue = new RemoteInputQueue(send);
    const typed = Promise.all([...'hello'].map(key => queue.invoke('terminal:input', ['panel', key])));
    await vi.advanceTimersByTimeAsync(1_000);
    await typed;
    expect(host).toBe('hello');
  });

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
    const results = await completed;
    expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Delivery unknown:') }) });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('queued terminal input was not sent') }) });
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

  it('sends a bare Enter in a write of its own, so an agent submits instead of reading it as part of a paste', async () => {
    const finish: Array<() => void> = [];
    const send = vi.fn((_channel: string, _args: unknown[], _signal?: AbortSignal) =>
      new Promise<void>(resolve => finish.push(resolve)));
    const queue = new RemoteInputQueue(send);
    const wheel = '\x1b[<65;40;12M';
    // A message sent while a scroll's wheel reports are in flight, then a key after it.
    const completed = Promise.all([wheel, wheel, 'fix the build', '\r', 'y'].map(key =>
      queue.invoke('terminal:input', ['panel', key])));
    const expected = [wheel, `${wheel}fix the build`, '\r', 'y'];
    for (const [index, data] of expected.entries()) {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(index + 1));
      expect(send.mock.calls[index][1]).toEqual(['panel', data]);
      finish[index]();
    }
    await completed;
    expect(send).toHaveBeenCalledTimes(expected.length);
  });

  it('holds a bare Enter until an agent that gathers fast text as a paste has taken in the text before it', async () => {
    vi.useFakeTimers();
    // Measured on Codex 0.172: an Enter that comes within about 15 ms + 0.35 ms per character of a
    // 200-character message lands in the box as a newline (it needed about 80 ms).
    const sentAt: Array<{ data: string; at: number }> = [];
    const send = vi.fn(async (_channel: string, args: unknown[]) => {
      sentAt.push({ data: String(args[1]), at: Date.now() });
    });
    const queue = new RemoteInputQueue(send);
    const message = 'x'.repeat(200);
    const done = Promise.all([queue.invoke('terminal:input', ['panel', message]), queue.invoke('terminal:input', ['panel', '\r'])]);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    expect(sentAt.map(write => write.data)).toEqual([message, '\r']);
    expect(sentAt[1].at - sentAt[0].at).toBeGreaterThanOrEqual(100);
  });

  it('adds no wait before a bare Enter when the text took longer than that to be answered', async () => {
    vi.useFakeTimers();
    const sentAt: number[] = [];
    const send = vi.fn((_channel: string, _args: unknown[]) => {
      sentAt.push(Date.now());
      return new Promise<void>(resolve => setTimeout(resolve, 300));
    });
    const queue = new RemoteInputQueue(send);
    const done = Promise.all([queue.invoke('terminal:input', ['panel', 'x'.repeat(200)]), queue.invoke('terminal:input', ['panel', '\r'])]);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;

    expect(sentAt[1] - sentAt[0]).toBe(300);
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
    vi.useFakeTimers();
    finish[1]();
    // A paste this long holds its Enter for the longest wait, 2 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][1]).toEqual(['panel', '\r']);
    finish[2]();
    await completed;
  });
});
