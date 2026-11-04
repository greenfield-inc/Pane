import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatWorkerLine } from '../../../../shared/chatTabPresentation';
import { watchSessionWorkers, type SessionWorkerSource, type SessionWorkersOverview } from './sessionWorkers';

function overview(state: 'done' | 'blocked', attachedAt = '2026-11-01T10:00:00.000Z'): SessionWorkersOverview {
  return {
    session: { associations: [{ paneId: 'p1', attachedAt }] },
    panes: [{ paneId: 'p1', name: 'fix-login', missing: false, archived: false, panels: [], report: { state, summary: 'Opened #12', question: state === 'blocked' ? 'Which DB?' : undefined } }],
  };
}

function fakeSource(first: SessionWorkersOverview) {
  let current: SessionWorkersOverview | null = first;
  const listeners = new Set<() => void>();
  const source: SessionWorkerSource = {
    overview: vi.fn(async () => current),
    onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  return {
    source,
    set: (next: SessionWorkersOverview | null) => { current = next; },
    emit: () => listeners.forEach(listener => listener()),
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
