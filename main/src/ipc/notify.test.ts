import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { NotifyQueue } from '../services/notify/notifyQueue';
import { registerNotifyHandlers } from './notify';
import { PaneError } from '../../../shared/paneError';
import { ConfigManager } from '../services/configManager';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyRemoteCommand, type NotifyResult, type NotifySharedState } from '../../../shared/types/notify';
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

  it('keeps a question that arrives while a reconnect read is in flight, and answers it on the host', async () => {
    const host = new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [], machine: 'mac-studio' });
    const sent: NotifyRemoteCommand[] = [];
    let finishRead: (state: NotifySharedState) => void = () => undefined;
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue(connected);
    vi.spyOn(remotePaneClientController, 'invoke').mockImplementation((channel: string, args: unknown[]) => {
      if (channel === 'notify:remote-snapshot') return new Promise<NotifySharedState>(resolve => { finishRead = resolve; });
      // SAFETY: Notify sends only NotifyRemoteCommand on notify:remote-command.
      const command = args[0] as NotifyRemoteCommand;
      sent.push(command);
      host.runRemote(command, 'parsa-air');
      return Promise.resolve(null);
    });
    host.on('change', () => remotePaneClientController.emit('notify-shared', host.sharedState()));
    const client = await startPane();

    // The reconnect read sees an empty queue; a question arrives as an event before the read returns.
    const emptyRead = host.sharedState();
    remotePaneClientController.emit('resync');
    void host.ask({ question: { ui: 'options', title: 'Which region?', choices: [{ label: 'us-east-1' }, { label: 'eu-west-1' }] }, source: { name: 'api', agent: 'Claude' } });
    finishRead(emptyRead);
    await flush();
    const [question] = client.notify.snapshot().items;
    expect(question).toMatchObject({ title: 'Which region?', state: 'waiting', machine: 'mac-studio' });

    await client.notify.run({ type: 'answer', id: question.id, answer: { choice: 'eu-west-1' } });
    expect(sent).toEqual([{ type: 'answer', id: question.id, answer: { choice: 'eu-west-1' } }]);
    expect(host.snapshot().items[0]).toMatchObject({ state: 'sent', answeredOn: 'parsa-air' });
    host.dispose();
    client.notify.dispose();
  });

  it("makes the host's question answerable again when the connection comes back without a resync", async () => {
    const host = new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [], machine: 'mac-studio' });
    let linkUp = true;
    const offline = Object.assign(new Error('Remote connection interrupted: the action was not sent.'), { code: 'ERR_REMOTE_OFFLINE' });
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue(connected);
    vi.spyOn(remotePaneClientController, 'invoke').mockImplementation((channel: string, args: unknown[]) => {
      if (!linkUp) return Promise.reject(offline);
      if (channel === 'notify:remote-snapshot') return Promise.resolve(host.sharedState());
      // SAFETY: Notify sends only NotifyRemoteCommand on notify:remote-command.
      host.runRemote(args[0] as NotifyRemoteCommand, 'parsa-air');
      return Promise.resolve(null);
    });
    host.on('change', () => remotePaneClientController.emit('notify-shared', host.sharedState()));
    const client = await startPane();
    void host.ask({ question: { ui: 'approve', title: 'Deploy the docs site?' }, source: { name: 'api', agent: 'Claude' } });
    await flush();
    const [question] = client.notify.snapshot().items;

    linkUp = false;
    await client.notify.run({ type: 'answer', id: question.id, answer: { approved: true } });
    await flush();
    expect(client.notify.snapshot().items[0]).toMatchObject({ state: 'waiting', unreachable: true });

    linkUp = true;
    remotePaneClientController.emit('state-changed');
    await flush();
    expect(client.notify.snapshot().items[0].unreachable).toBeUndefined();
    await client.notify.run({ type: 'answer', id: question.id, answer: { approved: true } });
    expect(host.snapshot().items[0]).toMatchObject({ state: 'sent', answeredOn: 'parsa-air' });
    host.dispose();
    client.notify.dispose();
  });

  it('sends an answer given while the connection is still restoring once it is connected', async () => {
    const host = new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [], machine: 'mac-studio' });
    let state: RemotePaneConnectionState = { ...connected, status: 'restoring' };
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockImplementation(() => state);
    vi.spyOn(remotePaneClientController, 'invoke').mockImplementation((channel: string, args: unknown[]) => {
      if (channel === 'notify:remote-snapshot') return Promise.resolve(host.sharedState());
      if (state.status !== 'connected') return Promise.reject(new PaneError('ERR_REMOTE_OFFLINE', 'The action was not sent while the workspace is disconnected or restoring.'));
      // SAFETY: Notify sends only NotifyRemoteCommand on notify:remote-command.
      host.runRemote(args[0] as NotifyRemoteCommand, 'parsa-air');
      return Promise.resolve(null);
    });
    host.on('change', () => remotePaneClientController.emit('notify-shared', host.sharedState()));
    void host.ask({ question: { ui: 'approve', title: 'Ship the hotfix tonight?' }, source: { name: 'api', agent: 'Claude' } });
    const client = await startPane();
    remotePaneClientController.emit('resync');
    await flush();
    const [question] = client.notify.snapshot().items;

    const answering = client.notify.run({ type: 'answer', id: question.id, answer: { approved: true } });
    await flush();
    expect(host.snapshot().items[0].state).toBe('waiting');
    state = connected;
    remotePaneClientController.emit('state-changed');
    await answering;
    expect(host.snapshot().items[0]).toMatchObject({ state: 'sent', answeredOn: 'parsa-air' });
    host.dispose();
    client.notify.dispose();
  });
});
