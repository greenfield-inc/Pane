import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { MachineHealthService } from '../services/machineHealth/machineHealthService';
import type { MemoryRelief } from '../services/machineHealth/memoryRelief';
import { MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, type HealthProcess, type MachineHealthSnapshot } from '../../../shared/types/machineHealth';
import type { AppServices } from './types';
import { registerResourceMonitorHandlers } from './resourceMonitor';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member the stop and restart handlers read.
  return value as Contract;
}

const devServer: HealthProcess = { pid: 4242, started: 'Mon Nov 16 09:00:00 2026', name: 'node', sessionId: 'pane-1', panelId: null, rssMB: 300, cpuPercent: 0, escaped: true };

function host() {
  const snapshot = partial<MachineHealthSnapshot>({ panes: [{ sessionId: 'pane-1', name: 'Pane 1', rssMB: 300, cpuPercent: 0, processes: [devServer] }] });
  const stopProcesses = vi.fn(async () => ({ at: 0, source: 'cli' as const, removed: [], skipped: [], freedBytes: 0 }));
  const services = partial<AppServices>({
    machineHealth: partial<MachineHealthService>({ getSnapshot: async () => snapshot }),
    memoryRelief: partial<MemoryRelief>({ stopProcesses }),
  });
  const registry = new PaneCommandRegistry();
  registerResourceMonitorHandlers(partial<IpcMain>({ handle: vi.fn() }), services, registry);
  return { registry, stopProcesses };
}

describe('stopping or restarting a process from outside', () => {
  it('refuses a pid the latest sample does not credit to a Pane, including a reused pid, and stops nothing', async () => {
    const { registry, stopProcesses } = host();
    const reused = { pid: 4242, started: 'Mon Nov 16 11:15:00 2026' };
    const stranger = { pid: 1, started: 'Mon Nov 16 08:00:00 2026' };

    await expect(registry.invoke(MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, [{ processes: [reused], source: 'cli' }])).rejects.toMatchObject({ code: 'ERR_MACHINE_PROCESS_NOT_PANES' });
    await expect(registry.invoke(MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, [{ processes: [{ pid: devServer.pid, started: devServer.started }, stranger], source: 'cli' }])).rejects.toMatchObject({ code: 'ERR_MACHINE_PROCESS_NOT_PANES' });
    await expect(registry.invoke(MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, [stranger])).rejects.toMatchObject({ code: 'ERR_MACHINE_PROCESS_NOT_PANES' });
    expect(stopProcesses).not.toHaveBeenCalled();
  });

  it('stops a process the latest sample credits to a Pane', async () => {
    const { registry, stopProcesses } = host();
    await registry.invoke(MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, [{ processes: [{ pid: devServer.pid, started: devServer.started }], source: 'cli' }]);
    expect(stopProcesses).toHaveBeenCalledWith([devServer], 'cli');
  });
});
