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
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { ConfigManager } from '../services/configManager';
import type { NotifyService } from '../services/notify/notifyService';

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
  function asker(saved: Array<{ id: string; name: string; archived?: boolean }>, agent: { resume?: string; ready?: Array<boolean | Error>; panelType?: string; draft?: boolean; prompt?: string; hostname?: string } = {}) {
    const typed: Array<{ panelId: string; input: string }> = [];
    const readiness = [...(agent.ready ?? [])];
    const created: Array<{ name: string }> = [];
    const cards: Array<{ context?: string }> = [];
    const view = (id: string, name: string) => ({ session: { id, name }, panel: { id: `panel-${id}`, type: agent.panelType ?? 'chat' }, internalSession: { worktreePath: '/tmp' } });
    const sessions = partial<OrchestrationSessionManager>({
      list: async () => partial({ sessions: saved.map(session => partial(session)) }),
      getView: async ({ sessionId }) => partial(view(sessionId ?? '', saved.find(session => session.id === sessionId)?.name ?? '')),
      create: async input => {
        // As the real manager does: a name already taken is refused. The await lets a racing click in.
        await new Promise(resolve => setTimeout(resolve, 5));
        if (saved.some(session => session.name === input.name)) throw new Error(`A Session named ${input.name} already exists`);
        saved.push({ id: 'new', name: input.name });
        created.push({ name: input.name });
        return partial(view('new', input.name));
      },
    });
    const registry = new PaneCommandRegistry();
    registry.register('runpane:panels:resume', async () => ({ action: agent.resume ?? 'already-running' }));
    registry.register('runpane:panels:wait', async () => {
      const next = readiness.shift() ?? true;
      if (next instanceof Error) throw next;
      return { ok: next };
    });
    registry.register('runpane:panels:screen', async () => ({ composer: { hasUndeliveredText: agent.draft ?? false } }));
    registry.register('runpane:panels:submit', async request => { typed.push(partial(request)); return { ok: true }; });
    const notifyService = partial<NotifyService>({ queue: partial<NotifyService['queue']>({ ask: async (input: { question: { context?: string } }) => { cards.push({ context: input.question.context }); return partial({}); } }) });
    const machineHealth = partial<MachineHealthService>({ latestSnapshot: () => partial<MachineHealthSnapshot>({ hostname: agent.hostname ?? 'devbox' }) });
    registerResourceMonitorHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({ orchestrationSessionManager: sessions, notifyService, machineHealth }), registry);
    return {
      ask: () => registry.invoke(MACHINE_HEALTH_ASK_AGENT_CHANNEL, [{ name: 'Clean up devbox', prompt: agent.prompt ?? 'Free memory.' }]),
      /** As a desktop from before Sessions sends it: the prompt alone. */
      askUnnamed: () => registry.invoke(MACHINE_HEALTH_ASK_AGENT_CHANNEL, [{ prompt: agent.prompt ?? 'Free memory.' }]),
      typed, created, cards,
    };
  }

  it('hands the request to the numbered Session that replaced an archived one, and starts no other', async () => {
    const { ask, typed, created } = asker([{ id: 'old', name: 'Clean up devbox', archived: true }, { id: 'two', name: 'Clean up devbox 2' }]);
    await expect(ask()).resolves.toEqual({ sessionId: 'two', panelId: 'panel-two', typed: true });
    expect(typed).toMatchObject([{ panelId: 'panel-two', input: 'Free memory.' }]);
    expect(created).toEqual([]);
  });

  afterEach(() => { resetPaneRuntimeForTests(); vi.restoreAllMocks(); });

  it('starts the next numbered Session when the name belongs to an archived one', async () => {
    // Creating reads the preferred shell to decide how the request reaches the new agent.
    setPaneRuntime(partial<PaneRuntime>({ getConfigManager: () => partial<ConfigManager>({ getPreferredShell: () => 'auto' }) }));
    const { ask, created } = asker([{ id: 'old', name: 'Clean up devbox', archived: true }, { id: 'x', name: 'Clean up devbox tools' }]);
    await expect(ask()).resolves.toMatchObject({ sessionId: 'new', panelId: 'panel-new' });
    expect(created).toEqual([{ name: 'Clean up devbox 2' }]);
  });

  it('shows the Session when its agent is slow to start, and later pastes the request into its input box unsent', async () => {
    const writes = vi.spyOn(terminalPanelManager, 'writeToTerminal').mockImplementation(() => undefined);
    vi.spyOn(terminalPanelManager, 'isBracketedPasteEnabled').mockReturnValue(true);
    const { ask, typed } = asker([{ id: 'one', name: 'Clean up devbox' }], { resume: 'resumed', ready: [false, true], panelType: 'terminal', prompt: 'Free memory.\n\nThe card listed:\n- node' });
    await expect(ask()).resolves.toEqual({ sessionId: 'one', panelId: 'panel-one', typed: false });
    // One bracketed paste: the newlines stay text and nothing presses Enter.
    await vi.waitFor(() => expect(writes).toHaveBeenCalledWith('panel-one', '\x1b[200~Free memory.\n\nThe card listed:\n- node\x1b[201~'));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(typed).toEqual([]);
  });

  it('leaves a draft the person is typing alone when the late agent gets ready', async () => {
    const writes = vi.spyOn(terminalPanelManager, 'writeToTerminal').mockImplementation(() => undefined);
    const { ask } = asker([{ id: 'one', name: 'Clean up devbox' }], { resume: 'resumed', ready: [false, true], panelType: 'terminal', draft: true });
    await expect(ask()).resolves.toMatchObject({ typed: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).not.toHaveBeenCalled();
  });

  it('names the Session for this machine when an older desktop sends no name (F-2)', async () => {
    setPaneRuntime(partial<PaneRuntime>({ getConfigManager: () => partial<ConfigManager>({ getPreferredShell: () => 'auto' }) }));
    const { askUnnamed, created } = asker([], { hostname: 'buildbox' });
    await expect(askUnnamed()).resolves.toMatchObject({ sessionId: 'new', panelId: 'panel-new' });
    expect(created).toEqual([{ name: 'Clean up buildbox' }]);
  });

  it('runs a quick second click after the first create, so it reuses that Session instead of failing (F-3)', async () => {
    setPaneRuntime(partial<PaneRuntime>({ getConfigManager: () => partial<ConfigManager>({ getPreferredShell: () => 'auto' }) }));
    const { ask, created } = asker([]);
    const [first, second] = await Promise.all([ask(), ask()]);
    expect(first).toMatchObject({ sessionId: 'new' });
    expect(second).toMatchObject({ sessionId: 'new' });
    expect(created).toEqual([{ name: 'Clean up devbox' }]);
  });

  it('forgets a late request when the 10-minute wait gives up, so the next slow start gets its own (F-7)', async () => {
    const writes = vi.spyOn(terminalPanelManager, 'writeToTerminal').mockImplementation(() => undefined);
    vi.spyOn(terminalPanelManager, 'isBracketedPasteEnabled').mockReturnValue(true);
    // First click: 30 s miss, then the late wait gives up. Second click: 30 s miss, then ready.
    const { ask } = asker([{ id: 'gave-up', name: 'Clean up devbox' }], { resume: 'resumed', ready: [false, false, false, true], panelType: 'terminal' });
    await expect(ask()).resolves.toMatchObject({ typed: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(ask()).resolves.toMatchObject({ typed: false });
    await vi.waitFor(() => expect(writes).toHaveBeenCalledWith('panel-gave-up', '\x1b[200~Free memory.\x1b[201~'));
  });

  it('forgets a late request when the late wait throws, so the next slow start gets its own (F-7)', async () => {
    const writes = vi.spyOn(terminalPanelManager, 'writeToTerminal').mockImplementation(() => undefined);
    vi.spyOn(terminalPanelManager, 'isBracketedPasteEnabled').mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ask } = asker([{ id: 'threw', name: 'Clean up devbox' }], { resume: 'resumed', ready: [false, new Error('panel closed'), false, true], panelType: 'terminal' });
    await expect(ask()).resolves.toMatchObject({ typed: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(ask()).resolves.toMatchObject({ typed: false });
    await vi.waitFor(() => expect(writes).toHaveBeenCalledWith('panel-threw', '\x1b[200~Free memory.\x1b[201~'));
  });

  it('tells a chat tab\'s person the request is sent for them, and a terminal\'s to press Enter (F-8)', async () => {
    const chat = asker([{ id: 'chat', name: 'Clean up devbox' }], { resume: 'resumed', ready: [false, false], panelType: 'chat' });
    await chat.ask();
    expect(chat.cards).toHaveLength(1);
    expect(chat.cards[0]?.context).not.toMatch(/Press Enter/u);
    expect(chat.cards[0]?.context).toMatch(/sent to the agent when it is ready/u);

    vi.spyOn(terminalPanelManager, 'writeToTerminal').mockImplementation(() => undefined);
    const terminal = asker([{ id: 'term', name: 'Clean up devbox' }], { resume: 'resumed', ready: [false, false], panelType: 'terminal' });
    await terminal.ask();
    expect(terminal.cards[0]?.context).toMatch(/Press Enter there to send it/u);
  });
});
