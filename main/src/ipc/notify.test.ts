import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { followSavedMachines, registerNotifyHandlers, type NotifyMachines } from './notify';
import { PaneError } from '../../../shared/paneError';
import { ConfigManager } from '../services/configManager';
import type { NotifyItem, NotifyResult, NotifySharedState } from '../../../shared/types/notify';
import type { MachineConnectionsEvent, MachineState } from '../../../shared/types/machineConnections';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';

/** A Pane's Notify handlers, registered the way the app registers them; no window or phone. */
async function startPane() {
  const registry = new PaneCommandRegistry();
  const configManager = new ConfigManager();
  await configManager.initialize();
  // Show outside Pane off: no floating windows in a test.
  await configManager.updateConfig({ notify: { showOutsidePane: false } });
  const services = { configManager, sessionManager: { getSession: () => undefined }, getMainWindow: () => null };
  return { registry, notify: registerNotifyHandlers(ipcMain, services, registry) };
}

const connected: RemotePaneConnectionState = {
  mode: 'remote', status: 'connected', activeProfileId: 'host-1', activeProfileLabel: 'mac-studio',
  activeBaseUrl: 'http://127.0.0.1:47911', lastError: null, lastSeenAt: null,
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** A waiting question as a machine shares it. */
function question(id: string, title: string, createdAt: number): NotifyItem {
  return { id, ui: 'approve', title, source: { name: 'api', agent: 'Claude' }, state: 'waiting', createdAt };
}

function stateOf(machine: string, ...items: NotifyItem[]): NotifySharedState {
  return { machine, epoch: `${machine}-started`, revision: 1, enabled: true, items, queue: items.map(item => item.id), hidden: [] };
}

/** Saved machines (id to its Notify state) behind a stand-in for the machine connections; records every command run. */
function savedMachines(states: Record<string, NotifySharedState>, initial: MachineState['status'] = 'online') {
  const listeners = new Set<(event: MachineConnectionsEvent) => void>();
  const statuses = new Map(Object.keys(states).map(id => [id, initial]));
  const sent: Array<[string, PaneCommandValue]> = [];
  const list = (): MachineState[] => [
    { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
    ...Object.keys(states).map((id): MachineState => ({ id, label: states[id].machine, kind: 'remote', status: statuses.get(id) ?? 'online', offlineSince: null })),
  ];
  const emit = (event: MachineConnectionsEvent) => { for (const listener of [...listeners]) listener(event); };
  const machines: NotifyMachines = {
    list,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    read: (machineId) => Promise.resolve({ machineId, data: states[machineId] }),
    run: (machineId, command) => { sent.push([machineId, command]); return Promise.resolve({ machineId, data: null }); },
  };
  return {
    machines,
    sent,
    emit,
    status: (id: string) => statuses.get(id),
    setStatus: (id: string, status: MachineState['status']) => { statuses.set(id, status); emit({ type: 'machines', machines: list() }); },
  };
}

describe('Notify across machines, through the registered handlers', () => {
  beforeEach(() => vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const event of ['notify-shared', 'resync', 'state-changed']) remotePaneClientController.removeAllListeners(event);
  });

  it('lets another device read the queue, answer it in its own name, and be refused once it is answered', async () => {
    const host = await startPane();
    const call = host.registry.invoke<NotifyResult>('runpane:notify', [{ ui: 'approve', title: 'Apply migration 0042?', caller: { cwd: '/repo/api' } }]);
    await flush();
    const state = await host.registry.invoke<NotifySharedState>('notify:remote-snapshot', []);
    expect(state.items).toMatchObject([{ state: 'waiting', source: { name: 'api' } }]);
    const id = state.items[0].id;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await host.registry.invoke('notify:remote-command', [{ type: 'answer', id, answer: { approved: true } }, { device: 'parsa-air' }]);
    await expect(host.registry.invoke('notify:remote-command', [{ type: 'answer', id, answer: { approved: false } }, { device: 'parsa-mini' }]))
      .rejects.toMatchObject({ code: 'ERR_NOTIFY_ANSWERED', message: 'Already answered on parsa-air. Nothing was sent.' });
    await vi.advanceTimersByTimeAsync(3_000);
    vi.useRealTimers();
    expect(await call).toEqual({ approved: true });
    host.notify.dispose();
  });

  it('counts one question from each of three machines, and each card names its machine', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship the hotfix tonight?', 1_000)), devbox: stateOf('parsa-devbox', question('q-7', 'Apply migration 0042?', 2_000)) });
    followSavedMachines(saved.machines);
    void pane.notify.ask({ ui: 'approve', title: 'Delete the old branch?', caller: { cwd: '/repo/api' } });
    await flush();

    const waiting = pane.notify.snapshot().items.filter(item => item.state === 'waiting');
    expect(waiting).toHaveLength(3);
    expect(pane.notify.queue.waitingItems()).toHaveLength(3);
    expect(waiting.map(item => [item.title, item.machineId])).toEqual([
      ['Delete the old branch?', 'local'],
      ['Ship the hotfix tonight?', 'studio'],
      ['Apply migration 0042?', 'devbox'],
    ]);
    expect(waiting.slice(1).map(item => [item.id, item.machine])).toEqual([['studio:q-1', 'mac-studio'], ['devbox:q-7', 'parsa-devbox']]);
    pane.notify.dispose();
  });

  it('keeps the same question id on two machines as two cards, and an answer reaches only its own machine', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)), devbox: stateOf('parsa-devbox', question('q-1', 'Ship it?', 2_000)) });
    followSavedMachines(saved.machines);
    await flush();
    expect(pane.notify.snapshot().queue).toEqual(['studio:q-1', 'devbox:q-1']);

    await pane.notify.run({ type: 'answer', id: 'devbox:q-1', answer: { approved: true } });
    await pane.notify.run({ type: 'skip', id: 'studio:q-1' });
    expect(saved.sent).toEqual([
      ['devbox', { type: 'notify', command: { type: 'answer', id: 'q-1', answer: { approved: true } } }],
      ['studio', { type: 'notify', command: { type: 'skip', id: 'q-1' } }],
    ]);
    pane.notify.dispose();
  });

  it("shows the machine the app is on once, and this computer's own question once", async () => {
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue(connected);
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    const pane = await startPane();
    void pane.notify.ask({ ui: 'approve', title: 'Delete the old branch?', caller: { cwd: '/repo/api' } });
    const studio = stateOf('mac-studio', question('q-1', 'Ship the hotfix tonight?', 1_000));
    // `self` is a saved machine that turns out to be this same running Pane.
    const saved = savedMachines({ 'host-1': studio, self: pane.notify.sharedState() });
    followSavedMachines(saved.machines);
    await flush();

    // The active connection's own stream, this computer's forwarded event and the machine's event all arrive.
    remotePaneClientController.emit('notify-shared', studio);
    saved.emit({ type: 'event', machineId: 'local', channel: 'notify:shared-changed', args: [pane.notify.sharedState()] });
    saved.emit({ type: 'event', machineId: 'host-1', channel: 'notify:shared-changed', args: [{ ...studio, revision: 2 }] });
    await flush();
    expect(pane.notify.snapshot().items.filter(item => item.state === 'waiting').map(item => item.title)).toEqual(['Delete the old branch?', 'Ship the hotfix tonight?']);
    // The machine the app is on keeps Open in Pane.
    expect(pane.notify.snapshot().items.find(item => item.id === 'host-1:q-1')?.elsewhere).toBeUndefined();
    pane.notify.dispose();
  });

  it("keeps an offline machine's question, dimmed and unanswerable, until it answers again", async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)) });
    followSavedMachines(saved.machines);
    await flush();

    saved.setStatus('studio', 'offline');
    expect(pane.notify.snapshot().items).toMatchObject([{ id: 'studio:q-1', state: 'waiting', unreachable: true, elsewhere: true }]);
    await pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: true } });
    expect(saved.sent).toEqual([]);

    saved.setStatus('studio', 'online');
    await flush();
    expect(pane.notify.snapshot().items[0].unreachable).toBeUndefined();
    await pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: true } });
    expect(saved.sent).toEqual([['studio', { type: 'notify', command: { type: 'answer', id: 'q-1', answer: { approved: true } } }]]);
    pane.notify.dispose();
  });

  it('keeps a question that arrives while a reconnect read is in flight', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio') });
    followSavedMachines(saved.machines);
    await flush();
    let finishRead: (state: NotifySharedState) => void = () => undefined;
    saved.machines.read = () => new Promise(resolve => { finishRead = state => resolve({ machineId: 'studio', data: state }); });

    // The reconnect read sees an empty queue; a question arrives as an event before the read returns.
    saved.emit({ type: 'resync', machineId: 'studio' });
    saved.emit({ type: 'event', machineId: 'studio', channel: 'notify:shared-changed', args: [{ ...stateOf('mac-studio', question('q-1', 'Which region?', 1_000)), revision: 2 }] });
    finishRead(stateOf('mac-studio'));
    await flush();
    expect(pane.notify.snapshot().queue).toEqual(['studio:q-1']);
    pane.notify.dispose();
  });

  it('sends an answer given while the machine is still connecting once it answers', async () => {
    const pane = await startPane();
    const saved = savedMachines({ studio: stateOf('mac-studio', question('q-1', 'Ship it?', 1_000)) }, 'connecting');
    const run = saved.machines.run;
    saved.machines.run = (machineId, command) => saved.status('studio') === 'online'
      ? run(machineId, command)
      : Promise.reject(new PaneError('ERR_MACHINE_OFFLINE', 'mac-studio is not connected, so the action was not sent.'));
    followSavedMachines(saved.machines);
    await flush();

    const answering = pane.notify.run({ type: 'answer', id: 'studio:q-1', answer: { approved: true } });
    await flush();
    expect(saved.sent).toEqual([]);
    saved.setStatus('studio', 'online');
    await answering;
    expect(saved.sent).toEqual([['studio', { type: 'notify', command: { type: 'answer', id: 'q-1', answer: { approved: true } } }]]);
    pane.notify.dispose();
  });
});
