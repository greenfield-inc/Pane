import { describe, expect, it } from 'vitest';
import type { HealthLevel, LeakWarning } from '../../../../shared/types/machineHealth';
import type { ResourceSnapshot } from '../../../../shared/types/resourceMonitor';
import { MachineHealthService, type LevelChange, type MachineHealthDeps } from './machineHealthService';

const GB = 1024 ** 3;
const MIN = 60_000;
const STARTED = 'Sun Nov 15 00:00:00 2026';
const T0 = Date.parse(STARTED);

function harness(extra: Partial<MachineHealthDeps> = {}) {
  const memory: HealthLevel = 'ok';
  const state = { now: T0, freeGB: 100, memory, rssMB: 100, processReadFails: false };
  const processes = async (): Promise<ResourceSnapshot> => {
    if (state.processReadFails) throw new Error('ps timed out');
    return {
    timestamp: state.now, cpuReady: true, totalCpuPercent: 0, totalMemoryMB: 0, electronProcesses: [],
    sessions: [{
      sessionId: 'A', sessionName: 'homepage', totalCpuPercent: 0, totalMemoryMB: state.rssMB,
      children: [{ pid: 42, name: 'vite', cpuPercent: 1, memoryMB: state.rssMB, started: STARTED, panelId: 'A1', escaped: false }],
    }],
    };
  };
  const service = new MachineHealthService({
    now: () => state.now,
    settings: () => ({ leakWindowMinutes: 5, leakSliceMinutes: 1, leakMinRssMB: 0, leakMinGrowthMB: 150, leakMinGrowthPercent: 50, leakMinAgeMinutes: 0 }),
    volumePaths: () => [],
    readDisk: async () => [{ path: '/data', roles: ['pane-data'], totalBytes: 500 * GB, freeBytes: state.freeGB * GB }],
    readMemory: async () => ({ level: state.memory, source: 'macos-pressure', detail: '' }),
    readSwap: async () => null,
    memory: () => ({ totalBytes: 32 * GB, freeBytes: 8 * GB }),
    cpuTimes: () => ({ idle: 0, total: 0 }),
    processes,
    scanInventory: async () => { throw new Error('not scanned in these tests'); },
    ...extra,
  });
  const changes: LevelChange[] = [];
  const leaks: LeakWarning[] = [];
  service.on('level-changed', change => changes.push(change));
  service.on('leak', leak => leaks.push(leak));
  return { state, service, changes, leaks };
}

describe('MachineHealthService', () => {
  it('reports disk levels against the default 20 GB warning and 5 GB critical thresholds', async () => {
    const { state, service, changes } = harness();
    await service.sample();
    state.freeGB = 21;
    await service.sample();
    state.freeGB = 19;
    const warning = await service.sample();
    state.freeGB = 4;
    await service.sample();
    expect(warning.disk).toMatchObject({ level: 'warning', volumes: [{ path: '/data', roles: ['pane-data'], freeBytes: 19 * GB, totalBytes: 500 * GB }] });
    expect(changes).toEqual([
      { kind: 'disk', level: 'warning', previous: 'ok' },
      { kind: 'disk', level: 'critical', previous: 'warning' },
    ]);
  });

  it('keeps the processes and a standing leak warning through a failed process read', async () => {
    const { state, service, leaks } = harness();
    for (let m = 0; m <= 7; m++) {
      state.now = T0 + m * MIN;
      state.rssMB = 200 + m * 40;
      await service.sample();
    }
    expect(leaks).toHaveLength(1);
    state.now = T0 + 8 * MIN;
    state.processReadFails = true;
    const failed = await service.sample();
    expect(failed.leaks).toHaveLength(1);
    expect(failed.panes.map(pane => pane.sessionId)).toEqual(['A']);
  });

  it('reports memory pressure only after two samples', async () => {
    const { state, service, changes } = harness();
    await service.sample();
    state.memory = 'warning';
    await service.sample();
    expect(changes).toEqual([]);
    await service.sample();
    expect(changes).toEqual([{ kind: 'memory', level: 'warning', previous: 'ok' }]);
  });

  it('warns once about a process that keeps climbing, and not after Ignore', async () => {
    const { state, service, leaks } = harness();
    for (let m = 0; m <= 7; m++) {
      state.now = T0 + m * MIN;
      state.rssMB = 200 + m * 40;
      await service.sample();
    }
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ pid: 42, name: 'vite', sessionId: 'A', panelId: 'A1', growthMB: 200, memoryMB: 400, series: [200, 240, 280, 320, 360, 400] });
    expect((await service.getSnapshot()).leaks).toHaveLength(1);

    service.ignoreLeak(42, STARTED);
    state.now = T0 + 8 * MIN;
    state.rssMB = 520;
    expect((await service.sample()).leaks).toEqual([]);
  });

  it('on macOS reads the footprint once a slice, so a leak shows while swapping keeps RSS flat', async () => {
    let footprintMB = 200;
    let reads = 0;
    const { state, service, leaks } = harness({ readFootprints: async () => { reads++; return new Map([[42, footprintMB]]); } });
    state.rssMB = 60;
    for (let s = 0; s <= 14; s++) {
      state.now = T0 + s * 30_000;
      footprintMB = 200 + Math.floor(s / 2) * 40;
      await service.sample();
    }
    expect(reads).toBe(8);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ memoryMB: 400, growthMB: 200, series: [200, 240, 280, 320, 360, 400] });
    // Between footprint reads the warning stands.
    state.now += 30_000;
    expect((await service.sample()).leaks).toHaveLength(1);
  });
});
