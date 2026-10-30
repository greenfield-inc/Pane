import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';
import { MachineConnections, type CreateMachineClient, type MachineClient } from './machineConnections';
import { SharedCredentialSync } from './sharedCredentialSync';
import { createDefaultRemoteDaemonConfig, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

type ClientOptions = Parameters<CreateMachineClient>[1];

interface FakeClient extends MachineClient {
  options: ClientOptions;
  invoke: ReturnType<typeof vi.fn<MachineClient['invoke']>>;
}

function profile(id: string): RemotePaneConnectionProfile {
  return { id, label: id, baseUrl: `http://${id}.tail1234.ts.net:4800/`, token: `token-${id}`, transport: 'http+sse' };
}

function setup(ids: string[]) {
  const configManager = new ConfigManager();
  const defaults = createDefaultRemoteDaemonConfig();
  vi.spyOn(configManager, 'getConfig').mockReturnValue({
    gitRepoPath: '',
    verbose: false,
    remoteDaemon: { ...defaults, client: { ...defaults.client, profiles: ids.map(profile) } },
  });
  const clients = new Map<string, FakeClient>();
  const invokeLocal = vi.fn(async () => ({ success: true }));
  const machines = new MachineConnections({
    configManager,
    invokeLocal,
    createClient: (saved, options) => {
      const client: FakeClient = {
        options,
        invoke: vi.fn<MachineClient['invoke']>(async (): Promise<JsonValue | undefined> => ({ success: true })),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        retryNow: vi.fn(async () => undefined),
      };
      clients.set(saved.id, client);
      return client;
    },
  });
  const events: MachineConnectionsEvent[] = [];
  machines.subscribe(event => events.push(event));
  machines.start();
  const client = (id: string): FakeClient => {
    const found = clients.get(id);
    if (!found) throw new Error(`no client for ${id}`);
    return found;
  };
  const connect = (id: string) => client(id).options.onConnectionStateChange?.('connected');
  return { configManager, machines, events, client, connect, invokeLocal };
}

describe('MachineConnections', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tags an event with the machine it came from, and a reconnect asks only that machine to be read again', () => {
    const { events, client } = setup(['studio-mac', 'build-box']);
    events.length = 0;

    client('build-box').options.eventSink?.send('session:updated', { id: 'pane-1', name: 'fix checkout' });
    client('build-box').options.onResyncRequired?.();

    expect(events).toEqual([
      { type: 'event', machineId: 'build-box', channel: 'session:updated', args: [{ id: 'pane-1', name: 'fix checkout' }] },
      { type: 'resync', machineId: 'build-box' },
    ]);
  });

  it('never forwards terminal output', () => {
    const { events, client } = setup(['build-box']);
    events.length = 0;

    client('build-box').options.eventSink?.send('terminal:output', { panelId: 'p1', data: 'secret bytes' });

    expect(events).toEqual([]);
  });

  it('runs a rename on the named machine only', async () => {
    const { machines, client, connect } = setup(['studio-mac', 'build-box']);
    connect('build-box');

    const result = await machines.run('build-box', { type: 'rename', target: { kind: 'pane', id: 'pane-1' }, name: 'Checkout fix' });

    expect(client('build-box').invoke).toHaveBeenCalledWith('sessions:rename', ['pane-1', 'Checkout fix']);
    expect(client('studio-mac').invoke).not.toHaveBeenCalled();
    expect(result).toEqual({ machineId: 'build-box', data: { success: true } });
  });

  it('refuses a command outside its list without sending anything', async () => {
    const { machines, client, connect } = setup(['build-box']);
    connect('build-box');

    await expect(machines.run('build-box', { type: 'permanent-delete', id: 'pane-1' }))
      .rejects.toMatchObject({ code: 'ERR_MACHINE_COMMAND_REFUSED', next: 'Switch to that machine to do this there.' });
    await expect(machines.read('build-box', 'sessions:permanent-delete-archived'))
      .rejects.toMatchObject({ code: 'ERR_MACHINE_READ_REFUSED' });
    expect(client('build-box').invoke).not.toHaveBeenCalled();
  });

  it('records when a machine went offline and keeps that time through its retries', () => {
    const { machines, client, connect } = setup(['build-box']);
    connect('build-box');

    vi.setSystemTime(new Date('2026-10-30T09:14:00.000Z'));
    client('build-box').options.onConnectionStateChange?.('reconnecting');
    vi.setSystemTime(new Date('2026-10-30T09:16:00.000Z'));
    client('build-box').options.onConnectionStateChange?.('error');

    expect(machines.list()).toEqual([
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
      { id: 'build-box', label: 'build-box', kind: 'remote', status: 'offline', offlineSince: '2026-10-30T09:14:00.000Z' },
    ]);
  });

  it('refuses a write to an offline machine before sending it', async () => {
    const { machines, client } = setup(['build-box']);
    client('build-box').options.onConnectionStateChange?.('reconnecting');

    await expect(machines.run('build-box', { type: 'archive', target: { kind: 'pane', id: 'pane-1' } }))
      .rejects.toMatchObject({ code: 'ERR_MACHINE_OFFLINE' });
    expect(client('build-box').invoke).not.toHaveBeenCalled();
  });

  it('answers a Notify card on this computer through its own commands', async () => {
    const { machines, invokeLocal } = setup([]);

    await machines.run('local', { type: 'notify', command: { type: 'answer', id: 'card-1', answer: { choice: 'Ship it' } } });

    expect(invokeLocal).toHaveBeenCalledWith('notify:remote-command', [
      { type: 'answer', id: 'card-1', answer: { choice: 'Ship it' } },
      { device: expect.any(String) },
    ]);
  });
});

describe('SharedCredentialSync over MachineConnections', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('syncs keys when a saved machine reports a settings change', async () => {
    const { configManager, machines, client } = setup(['build-box']);
    const sync = new SharedCredentialSync(configManager, machines);
    sync.start();
    await vi.advanceTimersByTimeAsync(1_000);
    client('build-box').invoke.mockClear();

    client('build-box').options.eventSink?.send('remote:settings-changed');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client('build-box').invoke).toHaveBeenCalledWith('credentials:shared:get', []);
    await sync.stop();
  });
});
