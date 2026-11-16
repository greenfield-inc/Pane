import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { MachineHealthService } from '../services/machineHealth/machineHealthService';
import type { MemoryRelief } from '../services/machineHealth/memoryRelief';
import { MACHINE_HEALTH_ASK_AGENT_CHANNEL, MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, type HealthProcess, type MachineHealthSnapshot } from '../../../shared/types/machineHealth';
import type { AppServices } from './types';
import type { OrchestrationSessionManager } from '../services/orchestrationSessionManager';
import { registerResourceMonitorHandlers } from './resourceMonitor';
import { resetPaneRuntimeForTests, setPaneRuntime, type PaneRuntime } from '../core/runtime';
import type { ConfigManager } from '../services/configManager';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member the stop and restart handlers read.
  return value as Contract;
}

const devServer: HealthProcess = { pid: 4242, started: 'Mon Nov 16 09:00:00 2026', name: 'node', sessionId: 'pane-1', panelId: null, rssMB: 300, cpuPercent: 0, escaped: true };
/** Sampled inside a WSL distro: no tab, never escaped, but not the run script's process. */
const wslNode: HealthProcess = { pid: 77, started: 'wsl:Ubuntu-24.04:77', name: 'node', sessionId: 'pane-1', panelId: null, rssMB: 900, cpuPercent: 0, escaped: false };

function host() {
  const snapshot = partial<MachineHealthSnapshot>({ panes: [{ sessionId: 'pane-1', name: 'Pane 1', rssMB: 300, cpuPercent: 0, processes: [devServer, wslNode] }] });
  const stopProcesses = vi.fn(async () => ({ at: 0, source: 'cli' as const, removed: [], skipped: [], freedBytes: 0 }));
  const services = partial<AppServices>({
    machineHealth: partial<MachineHealthService>({ getSnapshot: async () => snapshot, latestSnapshot: () => snapshot }),
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

  it('refuses to restart a process sampled inside WSL, which is not the run script\'s', async () => {
    const { registry } = host();
    await expect(registry.invoke(MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, [{ pid: wslNode.pid, started: wslNode.started }])).rejects.toMatchObject({ code: 'ERR_MACHINE_RESTART_UNSUPPORTED' });
  });

  it('stops a process the latest sample credits to a Pane', async () => {
    const { registry, stopProcesses } = host();
    await registry.invoke(MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, [{ processes: [{ pid: devServer.pid, started: devServer.started }], source: 'cli' }]);
    expect(stopProcesses).toHaveBeenCalledWith([devServer], 'cli');
  });
});

describe('Ask an agent', () => {
  function asker(saved: Array<{ id: string; name: string; archived?: boolean }>) {
    const typed: Array<{ panelId: string; input: string }> = [];
    const created: Array<{ name: string }> = [];
    const view = (id: string, name: string) => ({ session: { id, name }, panel: { id: `panel-${id}`, type: 'chat' }, internalSession: { worktreePath: '/tmp' } });
    const sessions = partial<OrchestrationSessionManager>({
      list: async () => partial({ sessions: saved.map(session => partial(session)) }),
      getView: async ({ sessionId }) => partial(view(sessionId ?? '', saved.find(session => session.id === sessionId)?.name ?? '')),
      create: async input => { created.push({ name: input.name }); return partial(view('new', input.name)); },
    });
    const registry = new PaneCommandRegistry();
    registry.register('runpane:panels:resume', async () => ({ action: 'already-running' }));
    registry.register('runpane:panels:wait', async () => ({ ok: true }));
    registry.register('runpane:panels:submit', async request => { typed.push(partial(request)); return { ok: true }; });
    registerResourceMonitorHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({ orchestrationSessionManager: sessions }), registry);
    return { ask: () => registry.invoke(MACHINE_HEALTH_ASK_AGENT_CHANNEL, [{ name: 'Clean up devbox', prompt: 'Free memory.' }]), typed, created };
  }

  it('hands the request to the numbered Session that replaced an archived one, and starts no other', async () => {
    const { ask, typed, created } = asker([{ id: 'old', name: 'Clean up devbox', archived: true }, { id: 'two', name: 'Clean up devbox 2' }]);
    await expect(ask()).resolves.toEqual({ sessionId: 'two', panelId: 'panel-two' });
    expect(typed).toMatchObject([{ panelId: 'panel-two', input: 'Free memory.' }]);
    expect(created).toEqual([]);
  });

  afterEach(() => { resetPaneRuntimeForTests(); });

  it('starts the next numbered Session when the name belongs to an archived one', async () => {
    // Creating reads the preferred shell to decide how the request reaches the new agent.
    setPaneRuntime(partial<PaneRuntime>({ getConfigManager: () => partial<ConfigManager>({ getPreferredShell: () => 'auto' }) }));
    const { ask, created } = asker([{ id: 'old', name: 'Clean up devbox', archived: true }, { id: 'x', name: 'Clean up devbox tools' }]);
    await expect(ask()).resolves.toEqual({ sessionId: 'new', panelId: 'panel-new' });
    expect(created).toEqual([{ name: 'Clean up devbox 2' }]);
  });
});
