import { describe, expect, it } from 'vitest';
import type { HealthProcess, MachineHealthSnapshot } from '../../../../shared/types/machineHealth';
import { leftoverProcesses, MemoryRelief, type MemoryReliefDeps } from './memoryRelief';

const proc = (pid: number, sessionId: string, escaped: boolean, rssMB = 40): HealthProcess =>
  ({ pid, started: `start-${pid}`, name: 'fake-runpane.js', sessionId, panelId: null, rssMB, cpuPercent: 0, escaped });

const snapshot = (processes: HealthProcess[], memory: 'ok' | 'warning' = 'ok'): MachineHealthSnapshot => ({
  sampledAt: 0, platform: 'darwin', hostname: 'h',
  disk: { level: 'ok', volumes: [] },
  memory: { level: memory, source: 'macos-pressure', detail: '', totalBytes: 0, freeBytes: 0, swapUsedBytes: null },
  cpuPercent: 0, app: { rssMB: 0, cpuPercent: 0 }, leaks: [],
  panes: [...new Set(processes.map(p => p.sessionId))].map(sessionId => ({ sessionId, name: sessionId, rssMB: 0, cpuPercent: 0, processes: processes.filter(p => p.sessionId === sessionId) })),
});

describe('leftoverProcesses', () => {
  it('lists every process that left its tab, whatever state its Pane is in, and nothing else', () => {
    const listed = leftoverProcesses(snapshot([proc(1, 'archived', true), proc(2, 'paused', true), proc(3, 'live', true), proc(4, 'live', false)]));
    expect(listed.map(p => p.pid)).toEqual([1, 2, 3]);
  });
});

function relief(over: Partial<MemoryReliefDeps> = {}) {
  const stopped: number[][] = [];
  const paused: number[] = [];
  const runs: unknown[] = [];
  const deps: MemoryReliefDeps = {
    now: () => 0,
    paneName: id => id,
    stop: async identities => { stopped.push(identities.map(identity => identity.pid)); return []; },
    idlePanes: () => ['idle-1', 'idle-2'],
    pauseIdle: async (_hours, paneIds) => { paused.push(1); return [...paneIds]; },
    pinned: () => false,
    paneMemoryMB: () => 300,
    settings: () => ({}),
    record: run => runs.push(run),
    ...over,
  };
  return { relief: new MemoryRelief(deps), stopped, paused, runs };
}

describe('MemoryRelief', () => {
  it('never stops a leftover by itself, even when its Pane is archived or paused', async () => {
    const { relief: r, stopped, runs } = relief({ settings: () => ({ autoPauseUnderPressure: true }) });
    await r.onSnapshot(snapshot([proc(1, 'archived', true), proc(2, 'paused', true)]));
    expect(stopped).toEqual([]);
    expect(runs).toEqual([]);
    expect(r.leftBehind().map(p => p.pid)).toEqual([1, 2]);
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

  it('never offers or pauses a pinned Pane', async () => {
    const asked: string[][] = [];
    const { relief: r } = relief({ pinned: id => id === 'idle-2', pauseIdle: async (_hours, paneIds) => { asked.push([...paneIds]); return [...paneIds]; } });
    expect(r.idleOffer().paneIds).toEqual(['idle-1']);
    const run = await r.pauseIdle('card');
    expect(asked).toEqual([['idle-1']]);
    expect(run.removed.map(item => item.id)).toEqual(['idle-1']);
  });

  it('reports a process that would not stop when asked', async () => {
    const { relief: r, runs } = relief({ stop: async identities => [...identities] });
    await r.stopProcesses([proc(1, 'live', true)], 'ui');
    expect(runs).toEqual([expect.objectContaining({ removed: [], skipped: [expect.objectContaining({ reason: 'It did not stop.' })] })]);
  });
});
