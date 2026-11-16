import { describe, expect, it } from 'vitest';
import type { HealthProcess, MachineHealthSnapshot } from '../../../../shared/types/machineHealth';
import { MemoryRelief, type MemoryReliefDeps, sortLeftovers } from './memoryRelief';

const proc = (pid: number, sessionId: string, escaped: boolean, rssMB = 40): HealthProcess =>
  ({ pid, started: `start-${pid}`, name: 'fake-runpane.js', sessionId, panelId: null, rssMB, cpuPercent: 0, escaped });

const snapshot = (processes: HealthProcess[], memory: 'ok' | 'warning' = 'ok'): MachineHealthSnapshot => ({
  sampledAt: 0, platform: 'darwin', hostname: 'h',
  disk: { level: 'ok', volumes: [] },
  memory: { level: memory, source: 'macos-pressure', detail: '', totalBytes: 0, freeBytes: 0, swapUsedBytes: null },
  cpuPercent: 0, app: { rssMB: 0, cpuPercent: 0 }, leaks: [],
  panes: [...new Set(processes.map(p => p.sessionId))].map(sessionId => ({ sessionId, name: sessionId, rssMB: 0, cpuPercent: 0, processes: processes.filter(p => p.sessionId === sessionId) })),
});

const state = new Map<string, 'archived' | 'paused' | 'open'>([['archived', 'archived'], ['paused', 'paused'], ['live', 'open']]);
const stateOf = (id: string) => state.get(id) ?? 'open';

describe('sortLeftovers', () => {
  it('stops escaped processes of archived and paused Panes by itself and lists those of live Panes', () => {
    const sorted = sortLeftovers(snapshot([proc(1, 'archived', true), proc(2, 'paused', true), proc(3, 'live', true), proc(4, 'live', false)]), stateOf);
    expect(sorted.stopNow.map(p => p.pid)).toEqual([1, 2]);
    expect(sorted.leftBehind.map(p => p.pid)).toEqual([3]);
  });
});

function relief(over: Partial<MemoryReliefDeps> = {}) {
  const stopped: number[][] = [];
  const paused: number[] = [];
  const runs: unknown[] = [];
  const deps: MemoryReliefDeps = {
    now: () => 0,
    paneState: stateOf,
    paneName: id => id,
    stop: async identities => { stopped.push(identities.map(identity => identity.pid)); return []; },
    idlePanes: () => ['idle-1', 'idle-2'],
    pauseIdle: async () => { paused.push(1); return ['idle-1', 'idle-2']; },
    paneMemoryMB: () => 300,
    settings: () => ({}),
    record: run => runs.push(run),
    ...over,
  };
  return { relief: new MemoryRelief(deps), stopped, paused, runs };
}

describe('MemoryRelief', () => {
  it('on each sample stops leftovers of archived and paused Panes, with their identities', async () => {
    const { relief: r, stopped, runs } = relief();
    await r.onSnapshot(snapshot([proc(1, 'archived', true), proc(3, 'live', true)]));
    expect(stopped).toEqual([[1]]);
    expect(runs).toEqual([expect.objectContaining({ source: 'schedule', removed: [expect.objectContaining({ kind: 'leftover-process', id: '1:start-1' })] })]);
  });

  it('offers to pause idle Panes under pressure, and pauses by itself only with the switch on, once per episode', async () => {
    const off = relief();
    await off.relief.onSnapshot(snapshot([], 'warning'));
    expect(off.paused).toEqual([]);
    expect(off.relief.idleOffer()).toEqual({ paneIds: ['idle-1', 'idle-2'], memoryMB: 600 });

    const on = relief({ settings: () => ({ autoPauseUnderPressure: true }) });
    await on.relief.onSnapshot(snapshot([], 'warning'));
    await on.relief.onSnapshot(snapshot([], 'warning'));
    expect(on.paused).toEqual([1]);
    await on.relief.onSnapshot(snapshot([], 'ok'));
    await on.relief.onSnapshot(snapshot([], 'warning'));
    expect(on.paused).toEqual([1, 1]);
  });

  it('reports a process that would not stop, and waits 30 minutes before trying it again by itself', async () => {
    let now = 0;
    const { relief: r, stopped, runs } = relief({ now: () => now, stop: async identities => { stopped.push(identities.map(identity => identity.pid)); return [...identities]; } });
    await r.onSnapshot(snapshot([proc(1, 'archived', true)]));
    await r.onSnapshot(snapshot([proc(1, 'archived', true)]));
    expect(stopped).toEqual([[1]]);
    expect(runs).toEqual([expect.objectContaining({ removed: [], skipped: [expect.objectContaining({ reason: 'It did not stop.' })] })]);
    now = 30 * 60_000;
    await r.onSnapshot(snapshot([proc(1, 'archived', true)]));
    expect(stopped).toEqual([[1], [1]]);
  });
});
