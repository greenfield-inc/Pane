import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatWorkerLine } from '../../../../shared/chatTabPresentation';
import { watchManySessionWorkers, watchSessionWorkers, type SessionWorkerSource, type SessionWorkersOverview } from './sessionWorkers';

function overview(state: 'done' | 'blocked', attachedAt = '2026-11-01T10:00:00.000Z'): SessionWorkersOverview {
  return {
    session: { associations: [{ paneId: 'p1', attachedAt }] },
    panes: [{ paneId: 'p1', name: 'fix-login', missing: false, archived: false, panels: [], report: { state, summary: 'Opened #12', question: state === 'blocked' ? 'Which DB?' : undefined } }],
  };
}

function fakeSource(first: SessionWorkersOverview) {
  let current: SessionWorkersOverview | null = first;
  const listeners = new Set<(sessionId?: string) => void>();
  const source: SessionWorkerSource = {
    overview: vi.fn(async () => current),
    onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  return {
    source,
    set: (next: SessionWorkersOverview | null) => { current = next; },
    emit: (sessionId?: string) => listeners.forEach(listener => listener(sessionId)),
    listeners,
  };
}

describe('watchSessionWorkers', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads the Session overview at once and turns it into worker lines', async () => {
    const fake = fakeSource(overview('done'));
    const seen: ChatWorkerLine[][] = [];
    watchSessionWorkers(fake.source, 's1', workers => seen.push(workers));
    await vi.runAllTimersAsync();
    expect(fake.source.overview).toHaveBeenCalledWith('s1');
    expect(seen).toEqual([[{ paneId: 'p1', name: 'fix-login', state: 'done', label: 'Done', detail: 'Opened #12', attachedAt: '2026-11-01T10:00:00.000Z' }]]);
  });

  it('reads once per burst of updates', async () => {
    const fake = fakeSource(overview('done'));
    const seen: ChatWorkerLine[][] = [];
    watchSessionWorkers(fake.source, 's1', workers => seen.push(workers));
    await vi.runAllTimersAsync();
    fake.set(overview('blocked'));
    fake.emit(); fake.emit(); fake.emit();
    await vi.runAllTimersAsync();
    expect(fake.source.overview).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)?.[0]).toMatchObject({ state: 'waiting', detail: 'Which DB?' });
  });

  it('stops listening and drops late answers once stopped', async () => {
    const fake = fakeSource(overview('done'));
    const seen: ChatWorkerLine[][] = [];
    const stop = watchSessionWorkers(fake.source, 's1', workers => seen.push(workers));
    stop();
    await vi.runAllTimersAsync();
    expect(seen).toEqual([]);
    expect(fake.listeners.size).toBe(0);
  });

  it('keeps the last lines when a read fails or returns nothing', async () => {
    const fake = fakeSource(overview('done'));
    const seen: ChatWorkerLine[][] = [];
    watchSessionWorkers(fake.source, 's1', workers => seen.push(workers));
    await vi.runAllTimersAsync();
    fake.set(null);
    fake.emit();
    await vi.runAllTimersAsync();
    vi.mocked(fake.source.overview).mockRejectedValueOnce(new Error('offline'));
    fake.emit();
    await vi.runAllTimersAsync();
    expect(seen).toHaveLength(1);
  });
});

describe('watchManySessionWorkers (D-276)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('merges every Session\'s workers in Session order, each Session read on its own, and stops them all', async () => {
    const panes = new Map<string, SessionWorkersOverview>([
      ['s1', { session: { associations: [] }, panes: [{ paneId: 'a', name: 'csv-export', missing: false, archived: false, panels: [{ state: 'working', panelId: 'a1', title: 'Claude Code' }] }] }],
      ['s2', { session: { associations: [] }, panes: [{ paneId: 'b', name: 'docs', missing: false, archived: false, panels: [{ state: 'idle' }] }] }],
    ]);
    const listeners = new Set<(sessionId?: string) => void>();
    const source: SessionWorkerSource = {
      overview: vi.fn(async (id: string) => panes.get(id)),
      onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    };
    const seen: string[][] = [];
    const stop = watchManySessionWorkers(source, ['s2', 's1', 's2'], workers => seen.push(workers.map(worker => `${worker.name}:${worker.state}`)));
    await vi.runAllTimersAsync();
    expect(source.overview).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual(['docs:idle', 'csv-export:running']);
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });
  it('reads again only the Session a change names, and every Session for a change naming none (review F-3 on #1281)', async () => {
    const fake = fakeSource(overview('done'));
    watchManySessionWorkers(fake.source, ['s1', 's2', 's3'], () => undefined);
    await vi.runAllTimersAsync();
    vi.mocked(fake.source.overview).mockClear();
    fake.emit('s2'); fake.emit('s2'); fake.emit('elsewhere');
    await vi.runAllTimersAsync();
    expect(vi.mocked(fake.source.overview).mock.calls).toEqual([['s2']]);
    vi.mocked(fake.source.overview).mockClear();
    fake.emit();
    await vi.runAllTimersAsync();
    expect(vi.mocked(fake.source.overview).mock.calls).toEqual([['s1'], ['s2'], ['s3']]);
  });

  it('never has two reads of a Session out at once: changes during a read ask for one more after it (review F-3 on #1281)', async () => {
    const fake = fakeSource(overview('done'));
    const answers: Array<() => void> = [];
    vi.mocked(fake.source.overview).mockImplementation(() => new Promise(resolve => { answers.push(() => resolve(overview('blocked'))); }));
    const seen: ChatWorkerLine[][] = [];
    watchSessionWorkers(fake.source, 's1', workers => seen.push(workers), 10);
    expect(fake.source.overview).toHaveBeenCalledTimes(1);
    for (let burst = 0; burst < 3; burst += 1) { fake.emit('s1'); await vi.advanceTimersByTimeAsync(20); }
    expect(fake.source.overview).toHaveBeenCalledTimes(1);
    answers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.source.overview).toHaveBeenCalledTimes(2);
    answers.shift()?.();
    await vi.runAllTimersAsync();
    expect(fake.source.overview).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
  });
  it('a watch replaced mid-read joins the read already out, and a stopped watch queues nothing (review F-3 follow-up on #1281)', async () => {
    const fake = fakeSource(overview('done'));
    const answers: Array<() => void> = [];
    vi.mocked(fake.source.overview).mockImplementation(() => new Promise(resolve => { answers.push(() => resolve(overview('blocked'))); }));
    const first = watchManySessionWorkers(fake.source, ['s1'], () => undefined, 10);
    fake.emit('s1');
    await vi.advanceTimersByTimeAsync(20);
    // S1's read is out and a refresh is queued behind it; Autopilot's walk changes.
    first();
    const seen: string[][] = [];
    watchManySessionWorkers(fake.source, ['s1', 's2'], workers => seen.push(workers.map(worker => worker.state)), 10);
    expect(vi.mocked(fake.source.overview).mock.calls).toEqual([['s1'], ['s2']]);
    while (answers.length) { answers.shift()?.(); await vi.advanceTimersByTimeAsync(0); }
    await vi.runAllTimersAsync();
    expect(vi.mocked(fake.source.overview).mock.calls).toEqual([['s1'], ['s2']]);
    expect(seen.at(-1)).toEqual(['waiting', 'waiting']);
  });

  it('keeps reading when one watch fails to apply an overview', async () => {
    const fake = fakeSource(overview('done'));
    const seen: ChatWorkerLine[][] = [];
    watchSessionWorkers(fake.source, 's1', () => { throw new Error('bad overview'); });
    watchSessionWorkers(fake.source, 's1', workers => seen.push(workers));
    await vi.runAllTimersAsync();
    expect(seen).toHaveLength(1);
  });
});
