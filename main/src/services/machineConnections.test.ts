import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';
import { MachineConnections, type CreateMachineClient, type MachineClient } from './machineConnections';
import { SharedCredentialSync } from './sharedCredentialSync';
import { readingMachines } from '../daemon/readingMachines';
import { createDefaultRemoteDaemonConfig, normalizeRemoteDaemonConfig, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

type ClientOptions = Parameters<CreateMachineClient>[1];

interface FakeClient extends MachineClient {
  options: ClientOptions;
  invoke: ReturnType<typeof vi.fn<MachineClient['invoke']>>;
  lastHeardAt: ReturnType<typeof vi.fn<MachineClient['lastHeardAt']>>;
}

function profile(id: string): RemotePaneConnectionProfile {
  return { id, label: id, baseUrl: `http://${id}.tail1234.ts.net:4800/`, token: id === 'tyler' ? 'pane_read_tyler' : `token-${id}`, transport: 'http+sse' };
}

const started: MachineConnections[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map(machines => machines.stop()));
});

function setup(ids: string[]) {
  const configManager = new ConfigManager();
  const defaults = createDefaultRemoteDaemonConfig();
  vi.spyOn(configManager, 'getConfig').mockReturnValue({
    gitRepoPath: '',
    verbose: false,
    // Saved before computers: each entry converts to one computer.
    remoteDaemon: normalizeRemoteDaemonConfig({ ...defaults, client: { ...defaults.client, computers: undefined, profiles: ids.map(profile) } }),
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
        suspend: vi.fn(),
        resume: vi.fn(),
        openPortStream: vi.fn(),
        measureLatency: vi.fn(async () => 4),
        lastHeardAt: vi.fn<MachineClient['lastHeardAt']>(() => null),
      };
      clients.set(saved.id, client);
      return client;
    },
  });
  const events: MachineConnectionsEvent[] = [];
  machines.subscribe(event => events.push(event));
  machines.start();
  started.push(machines);
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

  it('previews and switches a Session to chat on that machine, with the tabs the person confirmed', async () => {
    const { machines, client, connect } = setup(['build-box']);
    connect('build-box');

    await machines.run('build-box', { type: 'preview-switch-to-chat', sessionId: 's-1' });
    await machines.run('build-box', { type: 'switch-to-chat', sessionId: 's-1', panelIds: ['p-1', 'p-2'] });

    expect(client('build-box').invoke.mock.calls).toEqual([
      ['chat-tab:preview-session-switch', ['s-1']],
      ['chat-tab:switch-session', ['s-1', ['p-1', 'p-2']]],
    ]);
  });

  it('sends a Session\'s agent a message on that machine as the person, for Move to machine…', async () => {
    const { machines, client, connect } = setup(['build-box']);
    connect('build-box');

    await machines.run('build-box', { type: 'submit-to-agent', panelId: 's-1-c', input: 'Hand this Session off.' });

    expect(client('build-box').invoke.mock.calls).toEqual([
      ['runpane:panels:submit', [{ panelId: 's-1-c', input: 'Hand this Session off.', source: 'user' }]],
    ]);
    await expect(machines.run('build-box', { type: 'submit-to-agent', panelId: 's-1-c', input: '' }))
      .rejects.toThrow(/Pane can't send "submit-to-agent" to another machine/);
  });

  it('runs a machine health cleanup on the named machine through that machine\'s own engine', async () => {
    const { machines, client, connect } = setup(['studio-mac', 'build-box']);
    connect('build-box');

    await machines.run('build-box', { type: 'machine-health', action: 'cleanup', request: { kinds: ['agent-temp'], source: 'ui' } });
    await machines.run('build-box', { type: 'machine-health', action: 'pause-idle', request: { source: 'card' } });

    expect(client('build-box').invoke.mock.calls).toEqual([
      ['resource-monitor:machine-cleanup', [{ kinds: ['agent-temp'], source: 'ui' }]],
      ['resource-monitor:machine-pause-idle', [{ source: 'card' }]],
    ]);
    expect(client('studio-mac').invoke).not.toHaveBeenCalled();
  });

  it('sets a Pane\'s pin to the requested state in one host call', async () => {
    const { machines, client, connect } = setup(['build-box']);
    connect('build-box');

    await machines.run('build-box', { type: 'pin', target: { kind: 'pane', id: 'pane-1' }, pinned: true });

    expect(client('build-box').invoke.mock.calls).toEqual([['runpane:panes:pin', [{ paneId: 'pane-1', pinned: true }]]]);
  });

  it('drops the pending retry once the machine is back', async () => {
    const { client, connect } = setup(['build-box']);
    client('build-box').options.onConnectionStateChange?.('error');
    connect('build-box');
    vi.mocked(client('build-box').connect).mockClear();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(client('build-box').connect).not.toHaveBeenCalled();
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

  it('learns each machine\'s install id from its ready event, and when it came online', () => {
    vi.setSystemTime(new Date('2026-11-12T20:00:00.000Z'));
    const { machines, client, connect } = setup(['build-box']);
    client('build-box').options.onConnectionStateChange?.('restoring', null, { hostMachineId: 'c3d4-book' });
    connect('build-box');

    expect(machines.list().find(machine => machine.id === 'build-box')).toMatchObject({ installId: 'c3d4-book', status: 'online', onlineSince: '2026-11-12T20:00:00.000Z' });
  });

  it('offers nothing to share with a machine it only watches, and sends it no actions', async () => {
    const { machines, client, connect } = setup(['tyler', 'build-box']);
    client('tyler').options.onConnectionStateChange?.('restoring', null, { hostMachineId: 'tyler-install' });
    connect('tyler');
    connect('build-box');

    expect(machines.machineState('tyler')?.access).toBe('read');
    expect(machines.remotes().map(machine => machine.id)).toEqual(['build-box']);
    await expect(machines.run('tyler', { type: 'pin', target: { kind: 'pane', id: 'pane-1' }, pinned: true })).rejects.toMatchObject({ code: 'ERR_READ_ONLY_ACCESS' });
    expect(client('tyler').invoke).not.toHaveBeenCalled();
  });

  it('retries its offline machines at once when another Pane starts reading this computer, as a computer back from sleep does', () => {
    const { client, connect } = setup(['devbox', 'mini']);
    connect('mini');
    client('devbox').options.onConnectionStateChange?.('reconnecting');

    // A stream left half-open from before the devbox slept is still counted when its new one opens.
    readingMachines.add('devbox-install');
    expect(client('devbox').retryNow).toHaveBeenCalledTimes(1);
    readingMachines.add('devbox-install');
    readingMachines.remove('devbox-install');
    readingMachines.remove('devbox-install');

    expect(client('devbox').retryNow).toHaveBeenCalledTimes(2);
    expect(client('mini').retryNow).not.toHaveBeenCalled();
  });

  it('closes every saved machine\'s stream while this computer sleeps, and reopens them on wake', () => {
    const { machines, client } = setup(['build-box', 'mini']);
    machines.suspend();
    expect([client('build-box').suspend, client('mini').suspend].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
    machines.resume();
    expect([client('build-box').resume, client('mini').resume].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
  });

  it('measures a machine only once it is online, names the route it measured, and shares a measurement already running', async () => {
    const { machines, client } = setup(['build-box']);
    expect(await machines.measureLatency('build-box')).toEqual({ ms: null, routeId: null });
    expect(client('build-box').measureLatency).not.toHaveBeenCalled();
    client('build-box').options.onConnectionStateChange?.('connected', undefined, { routeId: 'relay:https://bb.runpane.net' });
    const [first, second] = await Promise.all([machines.measureLatency('build-box'), machines.measureLatency('build-box')]);
    expect(first).toEqual({ ms: 4, routeId: 'relay:https://bb.runpane.net' });
    expect(second).toEqual(first);
    expect(client('build-box').measureLatency).toHaveBeenCalledTimes(1);
  });

  it('says a machine answered recently only while it is online and heard from inside the window, and names its route', () => {
    const { machines, client } = setup(['build-box']);
    const heard = client('build-box').lastHeardAt;
    expect(machines.answeredWithin('build-box', 30_000)).toBeNull();
    client('build-box').options.onConnectionStateChange?.('connected', undefined, { routeId: 'lan:https://bb.local' });
    // Online, but not one event or heartbeat yet.
    expect(machines.answeredWithin('build-box', 30_000)).toBeNull();
    heard.mockReturnValue(Date.now());
    vi.advanceTimersByTime(29_000);
    expect(machines.answeredWithin('build-box', 30_000)).toEqual({ routeId: 'lan:https://bb.local' });
    vi.advanceTimersByTime(2_000);
    expect(machines.answeredWithin('build-box', 30_000)).toBeNull();
    heard.mockReturnValue(Date.now());
    client('build-box').options.onConnectionStateChange?.('reconnecting');
    expect(machines.answeredWithin('build-box', 30_000)).toBeNull();
    expect(machines.answeredWithin('nowhere', 30_000)).toBeNull();
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

  it('leaves out a machine this computer only watches: no keys, no Approvals switch', async () => {
    const { configManager, machines, client } = setup(['tyler', 'build-box']);
    client('tyler').options.onConnectionStateChange?.('restoring', null, { hostMachineId: 'tyler-install' });
    const sync = new SharedCredentialSync(configManager, machines);
    sync.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client('build-box').invoke).toHaveBeenCalledWith('credentials:shared:get', []);
    expect(client('tyler').invoke).not.toHaveBeenCalled();
    await sync.stop();
  });
});
