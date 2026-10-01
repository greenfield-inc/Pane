import { describe, expect, it, vi } from 'vitest';
import type { RemoteDaemonClientRecord, RemoteDaemonConnectedClient } from '../../../../shared/types/remoteDaemon';
import { createDefaultRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { TerminalPanelState, ToolPanel } from '../../../../shared/types/panels';
import type { CloudSafeToStopRequest } from '../../../../shared/types/cloudDaemon';
import type { AgentState } from '../../../../shared/types/agentStatus';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { hashRemoteDaemonToken } from '../auth';
import { PaneCommandRegistry } from '../commandRegistry';
import { UserClientActivityTracker } from './clientActivity';
import { registerCloudDaemonHandlers, type CloudDaemonDependencies } from './cloudDaemon';
import { CloudDaemonHealthState } from './readiness';
import type { ProcessEntry } from './processTree';

const NOW = 50_000_000;

function panel(id: string, paneId: string, customState: TerminalPanelState): ToolPanel {
  return {
    id,
    sessionId: paneId,
    type: 'terminal',
    title: id,
    state: { isActive: false, customState },
    metadata: { createdAt: '2026-09-29T00:00:00.000Z', lastActiveAt: '2026-09-29T00:00:00.000Z', position: 0 },
  };
}

function client(id: string, scope?: 'peer'): RemoteDaemonClientRecord {
  const record: RemoteDaemonClientRecord = { id, label: id, createdAt: '2026-09-29T00:00:00.000Z', tokenHash: `hash-${id}` };
  return scope ? Object.assign(record, { scope }) : record;
}

function setup(overrides: Partial<CloudDaemonDependencies> = {}) {
  const commandRegistry = new PaneCommandRegistry(() => NOW);
  const health = new CloudDaemonHealthState(() => NOW);
  health.setVersion('2.4.141', null);
  health.markDaemonReady();
  const clientActivity = new UserClientActivityTracker();
  const agentStates = new Map<string, AgentState>([['claude-1', 'idle']]);
  const running = new Set(['claude-1', 'shell-1']);
  const panels = [
    panel('claude-1', 'pane-1', { isCliPanel: true, agentType: 'claude' }),
    panel('codex-1', 'pane-1', { initialCommand: 'codex --yolo' }),
    panel('shell-1', 'pane-1', { initialCommand: 'bash' }),
  ];
  const config = createDefaultRemoteDaemonConfig();
  config.host.clients = [client('desktop'), client('peer-a', 'peer')];
  const connected: RemoteDaemonConnectedClient[] = [];
  const checkpointWal = vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 }));
  const processes: ProcessEntry[] = [
    { pid: 100, ppid: 1, name: 'bash' },
    { pid: 101, ppid: 100, name: 'claude' },
    { pid: 102, ppid: 101, name: 'node' },
  ];
  let foreground = { name: 'bash', isShell: true };
  const setForeground = (value: { name: string; isShell: boolean }) => {
    foreground = value;
  };
  const dependencies: CloudDaemonDependencies = {
    commandRegistry,
    health,
    clientActivity,
    terminals: {
      getAllPanelIds: () => [...running],
      getPanelPid: panelId => (panelId === 'claude-1' ? 100 : 200),
      getForegroundProcess: panelId => (panelId === 'shell-1' ? foreground : undefined),
      isTerminalInitialized: panelId => running.has(panelId),
      getAgentStatus: panelId => agentStates.get(panelId),
      getLastOutputAt: () => new Date(NOW - 10 * 60_000).toISOString(),
    },
    getPanel: panelId => panels.find(candidate => candidate.id === panelId),
    getPanelsForPane: paneId => panels.filter(candidate => candidate.sessionId === paneId),
    listPaneIds: () => ['pane-1'],
    listLocks: () => [],
    pendingPrChecks: async () => [],
    connectedClients: () => connected,
    remoteConfig: () => config,
    writeRemoteConfig: async (next) => {
      config.host = next.host;
    },
    checkpointWal,
    paneDirectory: '/nonexistent-pane-dir',
    databaseFile: '/nonexistent-pane-dir/sessions.db',
    readProcesses: () => processes,
    now: () => NOW,
    ...overrides,
  };
  registerCloudDaemonHandlers(dependencies);
  const safeToStop = (request: CloudSafeToStopRequest = { flush: 'never' }) =>
    commandRegistry.invoke('runpane:cloud:safe-to-stop', [request]);
  return { commandRegistry, health, clientActivity, agentStates, running, connected, config, checkpointWal, safeToStop, processes, setForeground };
}

function stream(clientId: string | null, label: string): RemoteDaemonConnectedClient {
  return { id: '1', clientId, label, deviceLabel: null, remoteAddress: null, connectedAt: '', lastSeenAt: '' };
}

describe('registerCloudDaemonHandlers', () => {
  it('counts agent panels of live Panes for readiness, not shells', () => {
    const { health, agentStates } = setup();
    expect(health.readiness()).toMatchObject({
      state: 'ready',
      agents: { expected: 2, ready: 1, notRunning: 1 },
    });

    agentStates.delete('claude-1');
    expect(health.readiness()).toMatchObject({ state: 'starting', agents: { starting: 1 } });
  });

  it('is safe when idle and blocks on a working agent', async () => {
    const { safeToStop, agentStates } = setup();
    await expect(safeToStop()).resolves.toMatchObject({ safe: true, blockers: [] });

    agentStates.set('claude-1', 'working');
    await expect(safeToStop()).resolves.toMatchObject({ safe: false, blockers: [{ condition: 'agent-working' }] });
  });

  it('blocks while an agent\'s background shell runs after its turn ended', async () => {
    const { safeToStop, processes } = setup();
    await expect(safeToStop()).resolves.toMatchObject({ safe: true });

    processes.push({ pid: 103, ppid: 101, name: 'bash' }, { pid: 104, ppid: 103, name: 'sleep' });
    await expect(safeToStop()).resolves.toMatchObject({
      blockers: [{ condition: 'command-running', message: 'Agent in panel claude-1 still runs a shell (bash pid 103)', panelId: 'claude-1' }],
    });
  });

  it('blocks while a shell panel runs a silent program', async () => {
    const { safeToStop, setForeground } = setup();
    setForeground({ name: 'make', isShell: false });

    await expect(safeToStop()).resolves.toMatchObject({
      blockers: [{ condition: 'command-running', message: 'Panel shell-1 is running make' }],
    });
  });

  it('reports a busy shell as recent output, not as a working agent', async () => {
    const { safeToStop, agentStates } = setup();
    agentStates.set('shell-1', 'working');

    await expect(safeToStop()).resolves.toMatchObject({ safe: true });
  });

  it('counts user event streams and recent user calls, never peers', async () => {
    const { safeToStop, connected, clientActivity, config } = setup();
    connected.push(stream('peer-a', 'peer-a'));
    clientActivity.recordInvoke({ record: config.host.clients[1], clientId: 'peer-a', label: 'peer-a', channel: 'runpane:panels:list', at: NOW });
    await expect(safeToStop()).resolves.toMatchObject({ safe: true });

    connected.push(stream('desktop', 'MacBook'));
    await expect(safeToStop()).resolves.toMatchObject({
      blockers: [{ condition: 'user-client-attached', message: 'MacBook has an open event stream' }],
    });

    connected.length = 0;
    clientActivity.recordInvoke({ record: config.host.clients[0], clientId: 'desktop', label: 'phone', channel: 'runpane:panes:list', at: NOW - 60_000 });
    await expect(safeToStop()).resolves.toMatchObject({
      blockers: [{ condition: 'user-client-attached', message: 'phone used the daemon 60s ago' }],
    });
    await expect(safeToStop({ flush: 'never', clientWindowMs: 30_000 })).resolves.toMatchObject({ safe: true });
  });

  it('never counts the coordinator\'s own cloud calls as user activity', async () => {
    const { safeToStop, clientActivity, config } = setup();
    clientActivity.recordInvoke({ record: config.host.clients[0], clientId: 'desktop', label: 'coord', channel: 'runpane:cloud:safe-to-stop', at: NOW });

    await expect(safeToStop()).resolves.toMatchObject({ safe: true });
  });

  it('treats a user or local wait as a watcher, but not a peer wait', async () => {
    const { safeToStop, commandRegistry } = setup();
    let release: () => void = () => {};
    commandRegistry.register('runpane:workspace:wait', () => new Promise<null>((resolve) => {
      release = () => resolve(null);
    }));

    const peerWait = commandRegistry.invoke('runpane:workspace:wait', [], { origin: 'remote-peer' });
    await expect(safeToStop()).resolves.toMatchObject({ safe: true });
    release();
    await peerWait;

    const localWait = commandRegistry.invoke('runpane:workspace:wait', [], { origin: 'local' });
    await expect(safeToStop()).resolves.toMatchObject({ blockers: [{ condition: 'watcher-active' }] });
    release();
    await localWait;
  });

  it('checkpoints the database when safe', async () => {
    const { safeToStop, checkpointWal } = setup();
    await safeToStop({});

    expect(checkpointWal).toHaveBeenCalledTimes(1);
  });

  it('refuses to answer safe when the database it flushed is missing', async () => {
    const { safeToStop } = setup();
    const result = await safeToStop({});

    expect(result.safe).toBe(false);
    expect(result.flush).toMatchObject({ durable: false });
    expect(result.blockers).toEqual([expect.objectContaining({ condition: 'flush-failed' })]);
  });

  it('revokes the coordinator\'s client records only, and pairs a single new one in their place', async () => {
    const { commandRegistry, config } = setup();
    config.host.clients.push({ ...client('coord-old'), scope: 'coordinator' });

    const paired = await commandRegistry.invoke('runpane:cloud:coordinator-client:pair', []);
    expect(paired).toMatchObject({ ok: true, revokedClientIds: ['coord-old'] });
    const { clientId, token } = decodeBoundary(paired, boundary.object({ clientId: boundary.string, token: boundary.string }));
    expect(config.host.clients.map(record => [record.id, record.scope])).toEqual([
      ['desktop', undefined], ['peer-a', 'peer'], [clientId, 'coordinator'],
    ]);
    expect(config.host.clients[2]).toMatchObject({ label: 'runpane-cloud-coordinator', tokenHash: hashRemoteDaemonToken(token) });

    await expect(commandRegistry.invoke('runpane:cloud:coordinator-client:revoke', []))
      .resolves.toEqual({ ok: true, revokedClientIds: [clientId] });
    expect(config.host.clients.map(record => record.id)).toEqual(['desktop', 'peer-a']);
    await expect(commandRegistry.invoke('runpane:cloud:coordinator-client:revoke', []))
      .resolves.toEqual({ ok: true, revokedClientIds: [] });
  });
});
