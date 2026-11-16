import { describe, expect, it } from 'vitest';
import type { HealthLevel, LeakWarning } from '../../../../shared/types/machineHealth';
import type { ResourceSnapshot } from '../../../../shared/types/resourceMonitor';
import { MachineHealthService, type LevelChange } from './machineHealthService';

const GB = 1024 ** 3;
const MIN = 60_000;
const STARTED = 'Sun Nov 15 00:00:00 2026';
const T0 = Date.parse(STARTED);

function harness() {
  const memory: HealthLevel = 'ok';
  const state = { now: T0, freeGB: 100, memory, rssMB: 100 };
  const processes = async (): Promise<ResourceSnapshot> => ({
    timestamp: state.now, cpuReady: true, totalCpuPercent: 0, totalMemoryMB: 0, electronProcesses: [],
    sessions: [{
      sessionId: 'A', sessionName: 'homepage', totalCpuPercent: 0, totalMemoryMB: state.rssMB,
      children: [{ pid: 42, name: 'vite', cpuPercent: 1, memoryMB: state.rssMB, started: STARTED, panelId: 'A1', escaped: false }],
    }],
  });
  const service = new MachineHealthService({
    now: () => state.now,
    settings: () => ({ diskWarningGB: 20, diskCriticalGB: 5, leakWindowMinutes: 5, leakSliceMinutes: 1, leakMinRssMB: 0, leakMinGrowthMB: 150, leakMinGrowthPercent: 50, leakMinAgeMinutes: 0 }),
    volumePaths: () => [],
    readDisk: async () => [{ path: '/', roles: ['pane-data'], totalBytes: 500 * GB, freeBytes: state.freeGB * GB, level: state.freeGB < 5 ? 'critical' : state.freeGB < 20 ? 'warning' : 'ok' }],
    readMemory: async () => ({ level: state.memory, source: 'macos-pressure', detail: '' }),
    readSwap: async () => null,
    memory: () => ({ totalBytes: 32 * GB, freeBytes: 8 * GB }),
    cpuTimes: () => ({ idle: 0, total: 0 }),
    processes,
  });
  const changes: LevelChange[] = [];
  const leaks: LeakWarning[] = [];
  service.on('level-changed', change => changes.push(change));
  service.on('leak', leak => leaks.push(leak));
  return { state, service, changes, leaks };
}

describe('MachineHealthService', () => {
  it('reports a disk level change on the sample that crosses the threshold', async () => {
    const { state, service, changes } = harness();
    await service.sample();
    state.freeGB = 13;
    await service.sample();
    expect(changes).toEqual([{ kind: 'disk', level: 'warning', previous: 'ok' }]);
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
    expect(leaks[0]).toMatchObject({ pid: 42, name: 'vite', sessionId: 'A', panelId: 'A1', growthMB: 200, rssMB: 400, series: [200, 240, 280, 320, 360, 400] });
    expect((await service.getSnapshot()).leaks).toHaveLength(1);

    service.ignoreLeak(42, STARTED);
    state.now = T0 + 8 * MIN;
    state.rssMB = 520;
    expect((await service.sample()).leaks).toEqual([]);
  });
});
