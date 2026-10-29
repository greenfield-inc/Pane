import { describe, expect, it, vi } from 'vitest';
import { RecentWrites, type InvokeAnswer } from './recentWrites';

const ran = (payload: string): Promise<{ answer: InvokeAnswer; keep: boolean }> =>
  Promise.resolve({ answer: { statusCode: 200, payload }, keep: true });

describe('RecentWrites', () => {
  it('replays a known id even when the client is at its maximum, and refuses new ids before running them', async () => {
    let now = 0;
    const writes = new RecentWrites(() => now, 600_000, 3);
    for (const id of ['a', 'b', 'c']) await writes.answer('phone', id, () => ran(id));
    const run = vi.fn(() => ran('again'));

    await expect(writes.answer('phone', 'a', run)).resolves.toEqual({ statusCode: 200, payload: 'a' });
    expect(writes.answer('phone', 'd', run)).toBe('full');
    expect(run).not.toHaveBeenCalled();
    // Another client has its own share.
    await expect(writes.answer('desktop', 'd', run)).resolves.toEqual({ statusCode: 200, payload: 'again' });

    now = 600_001;
    await expect(writes.answer('phone', 'd', () => ran('d'))).resolves.toEqual({ statusCode: 200, payload: 'd' });
  });

  it('keeps every answer for its whole window, however many writes follow', async () => {
    let now = 0;
    const writes = new RecentWrites(() => now, 600_000, 10);
    await writes.answer('phone', 'first', () => ran('first'));
    for (let id = 0; id < 8; id += 1) { now += 1_000; await writes.answer('phone', `later-${id}`, () => ran('later')); }
    const run = vi.fn(() => ran('twice'));
    now = 599_999;
    await expect(writes.answer('phone', 'first', run)).resolves.toEqual({ statusCode: 200, payload: 'first' });
    expect(run).not.toHaveBeenCalled();
  });
});
