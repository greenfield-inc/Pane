import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { ToolPanel } from '../../../shared/types/panels';
import type { RemoteDaemonConnectedClient } from '../../../shared/types/remoteDaemon';
import type { AppServices } from './types';
import { registerHostStopCommands, type HostConnectedClient } from './hostStop';

function agentPanel(id: string, sessionId: string, title: string): ToolPanel {
  return {
    id,
    sessionId,
    type: 'terminal',
    title,
    state: { isActive: true, customState: { agentType: 'claude', isCliPanel: true } },
    metadata: { createdAt: '2026-11-05T00:00:00.000Z', lastActiveAt: '2026-11-05T00:00:00.000Z', position: 0 },
  };
}

function connected(person: string | null, deviceLabel: string): RemoteDaemonConnectedClient {
  return {
    id: '1', clientId: 'client-1', label: 'Office host', deviceLabel, remoteAddress: '127.0.0.1',
    connectedAt: '2026-11-05T10:00:00.000Z', lastSeenAt: '2026-11-05T10:00:05.000Z', person,
  };
}

/** One Pane, "fix-login", with one agent tab whose state the test sets. */
function createHost(options: { agentState?: 'working' | 'blocked' | 'idle'; clients?: HostConnectedClient[] } = {}) {
  vi.spyOn(panelManager, 'getPanelsForSession').mockImplementation((paneId: string) => (paneId === 'pane-1' ? [agentPanel('panel-1', 'pane-1', 'Claude Code')] : []));
  vi.spyOn(terminalPanelManager, 'getAgentStatus').mockReturnValue(options.agentState ?? 'idle');
  vi.spyOn(terminalPanelManager, 'saveAllTerminalStates').mockResolvedValue();
  // SAFETY: This test fixture supplies the two service reads host status makes.
  const services: AppServices = {
    databaseService: { getAllSessions: () => [{ id: 'pane-1', name: 'fix-login' }] },
    archiveProgressManager: { hasActiveTasks: () => false },
  } as never;
  const registry = new PaneCommandRegistry();
  registerHostStopCommands(registry, services, () => options.clients ?? []);
  return registry;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runpane host status', () => {
  it('is safe to stop when no agent is working and nobody is connected', async () => {
    const status = await createHost().invoke('runpane:host:status');
    expect(status).toMatchObject({ safeToStop: true, blockers: [], agents: { working: 0, blocked: 0, idle: 1 }, clients: [] });
  });

  it('is not safe while an agent is working, and names it', async () => {
    const status = await createHost({ agentState: 'working' }).invoke('runpane:host:status');
    expect(status).toMatchObject({
      safeToStop: false,
      blockers: [{ code: 'agent-working', paneId: 'pane-1', panelId: 'panel-1', title: 'fix-login · Claude Code' }],
      agents: { working: 1, blocked: 0, idle: 0 },
    });
  });

  it('stays safe while an agent only waits for an answer', async () => {
    const status = await createHost({ agentState: 'blocked' }).invoke('runpane:host:status');
    expect(status).toMatchObject({ safeToStop: true, agents: { working: 0, blocked: 1, idle: 0 } });
  });

  it('is not safe while someone is connected, and says who', async () => {
    const registry = createHost({ clients: [{ listener: 'paired', client: connected('Ada', 'iPhone') }] });
    const status = await registry.invoke('runpane:host:status');
    expect(status).toMatchObject({
      safeToStop: false,
      blockers: [{ code: 'client-connected', person: 'Ada', device: 'iPhone' }],
      clients: [{ person: 'Ada', device: 'iPhone', listener: 'paired', connectedAt: '2026-11-05T10:00:00.000Z' }],
    });
  });

  it('is not safe while a command is still changing the workspace', async () => {
    const registry = createHost();
    let finish = () => {};
    registry.register('sessions:rename', () => new Promise<void>((resolve) => { finish = resolve; }));
    const running = registry.invoke('sessions:rename');

    await expect(registry.invoke('runpane:host:status')).resolves.toMatchObject({ safeToStop: false, blockers: [{ code: 'work-in-flight', mutations: 1 }] });
    finish();
    await running;
    await expect(registry.invoke('runpane:host:status')).resolves.toMatchObject({ safeToStop: true });
  });
});

describe('runpane host prepare-stop', () => {
  it('lets running work finish, refuses new work, then accepts work again a minute later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const registry = createHost();
    let finish = () => {};
    let finished = false;
    registry.register('sessions:rename', () => new Promise<void>((resolve) => { finish = () => { finished = true; resolve(); }; }));
    registry.register('sessions:stop', () => undefined);
    const running = registry.invoke('sessions:rename');

    const preparing = registry.invoke('runpane:host:prepare-stop');
    await expect(registry.invoke('sessions:stop')).rejects.toMatchObject({ code: 'ERR_UPDATE_QUIESCING' });
    finish();
    await running;
    await expect(preparing).resolves.toEqual({ ready: true, settledMutations: 1 });
    expect(finished).toBe(true);
    expect(terminalPanelManager.saveAllTerminalStates).toHaveBeenCalledOnce();
    await expect(registry.invoke('runpane:host:status')).resolves.toMatchObject({ blockers: [{ code: 'update-in-progress' }] });

    vi.advanceTimersByTime(60_000);
    await expect(registry.invoke('sessions:stop')).resolves.toBeUndefined();
  });
});
