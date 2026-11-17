import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { archivedLine, createArchiveHold } from './archiveHold';

const deploy = { key: 'mac:question:q1', id: 'q1', title: 'Deploy to staging?' };
const rename = { key: 'mac:question:q2', id: 'q2', title: 'Rename the table?' };

describe('createArchiveHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hides a swiped row for five seconds, then closes it', () => {
    const close = vi.fn(() => new Promise(() => {}));
    const hold = createArchiveHold(close);
    hold.archive(deploy);
    expect(hold.snapshot().hidden.has(deploy.key)).toBe(true);
    vi.advanceTimersByTime(4_999);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledWith('q1');
    // Still hidden while the close is in flight.
    expect(hold.snapshot().held).toEqual([]);
    expect(hold.snapshot().hidden.has(deploy.key)).toBe(true);
  });

  it('sends nothing after Undo and shows the rows again', () => {
    const close = vi.fn(() => Promise.resolve());
    const hold = createArchiveHold(close);
    hold.archive(deploy);
    hold.archive(rename);
    hold.undo();
    vi.advanceTimersByTime(10_000);
    expect(close).not.toHaveBeenCalled();
    expect(hold.snapshot().hidden.size).toBe(0);
  });

  it('restarts the timer on a second archive and closes both together', () => {
    const close = vi.fn(() => Promise.resolve());
    const hold = createArchiveHold(close);
    hold.archive(deploy);
    vi.advanceTimersByTime(3_000);
    hold.archive(rename);
    vi.advanceTimersByTime(3_000);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(close.mock.calls).toEqual([['q1'], ['q2']]);
  });

  it('shows the row again when its close fails', async () => {
    const hold = createArchiveHold(() => Promise.reject(new Error('offline')));
    hold.archive(deploy);
    hold.flush();
    await vi.runAllTimersAsync();
    expect(hold.snapshot().hidden.has(deploy.key)).toBe(false);
  });
});

describe('archivedLine', () => {
  it('names one approval and counts several', () => {
    expect(archivedLine([deploy])).toBe('Archived Deploy to staging?');
    expect(archivedLine([deploy, rename])).toBe('Archived 2 approvals');
  });
});
