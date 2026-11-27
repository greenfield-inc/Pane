import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';
import { MachineConnections, type CreateMachineClient, type MachineClient } from './machineConnections';
import { SharedCredentialSync } from './sharedCredentialSync';
import { readingMachines } from '../daemon/readingMachines';
import { createDefaultRemoteDaemonConfig, normalizeRemoteDaemonConfig, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import type { RemoteComputer } from '../../../shared/types/remoteComputers';
import type { AppConfig } from '../types/config';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

type ClientOptions = Parameters<CreateMachineClient>[1];

interface FakeClient extends MachineClient {
  options: ClientOptions;
  invoke: ReturnType<typeof vi.fn<MachineClient['invoke']>>;
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

  it('passes on only the chat a window follows, from its machine, and never on machines:event (T-116 PR 6)', () => {
    const { machines, events, client } = setup(['studio-mac', 'build-box']);
    events.length = 0;
    const heard: Array<{ channel: string; payload: unknown }> = [];
    const stop = machines.followChat('build-box', 'chat-1', (channel, payload) => heard.push({ channel, payload }));
    const shown = { panelId: 'chat-1', generation: 2, revision: 7, index: 0, change: { type: 'append' } };

    client('build-box').options.eventSink?.send('chat-tab:event', shown);
    client('build-box').options.eventSink?.send('chat-tab:view', { panelId: 'chat-1', status: 'working' });
    // Another chat on the same machine, and the same panel id on another machine, are not followed.
    client('build-box').options.eventSink?.send('chat-tab:event', { ...shown, panelId: 'chat-2' });
    client('studio-mac').options.eventSink?.send('chat-tab:event', shown);
    stop();
    client('build-box').options.eventSink?.send('chat-tab:event', shown);

    expect(heard).toEqual([
      { channel: 'chat-tab:event', payload: shown },
      { channel: 'chat-tab:view', payload: { panelId: 'chat-1', status: 'working' } },
    ]);
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

describe('MachineConnections: which saved computers are yours (D-500)', () => {
  const tailscaleRoute = (name: string, token = `token-${name}`): RemoteComputer['routes'][number] => ({
    id: `tailscale:https://${name}.tail1.ts.net:4800`, kind: 'tailscale', source: 'found', baseUrl: `https://${name}.tail1.ts.net:4800`, token, tailnetMachine: name, tailnetDomain: 'tail1.ts.net',
  });
  const relayRoute = (name: string): RemoteComputer['routes'][number] => ({
    id: `relay:https://${name}.relay.example`, kind: 'relay', source: 'link', baseUrl: `https://${name}.relay.example`, token: `token-${name}`, relay: { computerId: `${name}-relay`, fingerprint: `fp-${name}` },
  });
  /** A Same network route, pinned like the relay route to the computer's relay key. */
  const lanRoute = (name: string): RemoteComputer['routes'][number] => ({
    id: `lan:https://l192-168-1-20.${name}-relay.relay.example`, kind: 'lan', source: 'found', baseUrl: `https://l192-168-1-20.${name}-relay.relay.example`, token: `token-${name}`, relay: { computerId: `${name}-relay`, fingerprint: `fp-${name}` },
  });
  /** The relay key a machine holds, as it answers over Tailscale. */
  const keyOf = (name: string) => ({ computerId: `${name}-relay`, fingerprint: `fp-${name}` });

  /** Saved computers whose config changes as the mark and the switch are saved; `logins` is who owns each Tailscale name, as Tailscale here reports it. */
  /**
   * `logins`: who owns each Tailscale name, as Tailscale here reports it. `keys`: the relay key each
   * Tailscale name's machine holds, read by the side check. `reached`: the relay key of the machine at
   * the other end of each computer's connection, as `computers:routes-report` answers over it.
   */
  function own(computers: RemoteComputer[], logins: Record<string, boolean | undefined>, keys: Record<string, { computerId: string; fingerprint: string } | null | undefined> = {}, reached: Record<string, { computerId: string; fingerprint: string }> = {}) {
    const configManager = new ConfigManager();
    const defaults = createDefaultRemoteDaemonConfig();
    let config: AppConfig = { gitRepoPath: '', verbose: false, remoteDaemon: { ...defaults, client: { ...defaults.client, computers } } };
    vi.spyOn(configManager, 'getConfig').mockImplementation(() => config);
    const change = (id: string, update: (computer: RemoteComputer) => RemoteComputer) => {
      const remote = config.remoteDaemon!;
      config = { ...config, remoteDaemon: { ...remote, client: { ...remote.client, computers: remote.client.computers.map(computer => (computer.id === id ? update(computer) : computer)) } } };
      configManager.emit('config-updated', config);
    };
    const checks: string[] = [];
    const probes: string[] = [];
    const clients = new Map<string, ClientOptions>();
    const machines = new MachineConnections({
      configManager,
      invokeLocal: vi.fn(async () => ({ success: true })),
      createClient: (saved, options) => {
        clients.set(saved.id, options);
        const invoke = vi.fn(async (channel: string): Promise<JsonValue | undefined> => {
          const key = reached[saved.id];
          if (channel !== 'computers:routes-report' || !key) return undefined;
          return { machineId: `${saved.id}-install`, name: saved.id, relay: { id: key.computerId, address: 'https://relay.example', fingerprint: key.fingerprint, local: [] } };
        });
        return { invoke, connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), retryNow: vi.fn(async () => undefined), suspend: vi.fn(), resume: vi.fn(), openPortStream: vi.fn(), measureLatency: vi.fn(async () => 4) };
      },
      ownership: {
        check: async ({ name }) => { checks.push(name); return logins[name]; },
        relayKey: async ({ name }) => { probes.push(name); return keys[name]; },
        save: async (computerId, mine, relay) => change(computerId, computer => {
          const next = { ...computer };
          delete next.mine;
          delete next.mineRelay;
          if (mine) next.mine = 'tailscale';
          if (mine && relay) next.mineRelay = relay;
          return next;
        }),
      },
    });
    machines.start();
    started.push(machines);
    const mine = (id: string) => machines.machineState(id)?.mine === true;
    /** Connects over the given route (the computer's first by default), as the client reports it. */
    const connect = (id: string, routeId?: string) => {
      const route = routeId ?? config.remoteDaemon?.client.computers.find(computer => computer.id === id)?.routes[0]?.id;
      clients.get(id)?.onConnectionStateChange?.('connected', null, route ? { routeId: route } : undefined);
    };
    const drop = (id: string) => clients.get(id)?.onConnectionStateChange?.('reconnecting');
    return { machines, mine, connect, drop, checks, probes, keys, reached, change, saved: (id: string) => config.remoteDaemon?.client.computers.find(computer => computer.id === id), logins };
  }

  it('marks a saved computer yours once it connects over its Tailscale route and Tailscale names this computer\'s login as its owner', async () => {
    const { mine, saved, connect, checks } = own([{ id: 'studio', label: 'studio', routes: [tailscaleRoute('studio')] }], { studio: true });
    await new Promise(resolve => setImmediate(resolve));
    // Opened, not connected: nothing has proved which machine answers yet.
    expect(checks).toEqual([]);

    connect('studio');
    await vi.waitFor(() => expect(mine('studio')).toBe(true));
    expect(saved('studio')?.mine).toBe('tailscale');
  });

  it('never marks one owned by another login, or one with no Tailscale route (relay only)', async () => {
    const { mine, connect, checks, saved } = own([
      { id: 'teammate', label: 'teammate', mine: 'tailscale', routes: [tailscaleRoute('teammate')] },
      { id: 'linked', label: 'linked', mine: 'tailscale', routes: [relayRoute('linked')] },
    ], { teammate: false });
    connect('teammate');
    connect('linked');
    await vi.waitFor(() => expect(saved('teammate')?.mine).toBeUndefined());
    await vi.waitFor(() => expect(saved('linked')?.mine).toBeUndefined());
    expect(checks).toEqual(['teammate']);
    expect(mine('teammate')).toBe(false);
    expect(mine('linked')).toBe(false);
  });

  it('never trusts a Tailscale name the host reported about itself: a teammate\'s host claiming yours isn\'t marked (review S-6)', async () => {
    // A teammate's host, linked over the relay, reported one of your machines' Tailscale names as its own.
    const claimed = { ...tailscaleRoute('studio'), id: 'tailscale:https://studio.tail1.ts.net:4800#claimed' };
    // Dialed over Tailscale, that name reaches your real studio, which holds its own relay key, not the teammate's.
    const { mine, connect, probes, saved } = own([{ id: 'mallory', label: 'mallory', routes: [relayRoute('mallory'), claimed] }], { studio: true }, { studio: keyOf('studio') });

    connect('mallory', relayRoute('mallory').id);
    await vi.waitFor(() => expect(probes).toEqual(['studio']));
    await new Promise(resolve => setImmediate(resolve));

    expect(saved('mallory')?.mine).toBeUndefined();
    expect(mine('mallory')).toBe(false);
  });

  it('marks a computer connected over Same network through a side check on its Tailscale route, when the machine there holds the same relay key', async () => {
    const { mine, connect, probes, checks } = own([{ id: 'macbook', label: 'macbook', routes: [lanRoute('macbook'), tailscaleRoute('macbook'), relayRoute('macbook')] }], { macbook: true }, { macbook: keyOf('macbook') });

    connect('macbook');
    await vi.waitFor(() => expect(mine('macbook')).toBe(true));
    expect(probes).toEqual(['macbook']);
    expect(checks).toEqual(['macbook']);
  });

  it('never side-checks a relay-only computer, and never marks from a side check whose login is someone else\'s', async () => {
    const { mine, connect, probes } = own([
      { id: 'linked', label: 'linked', routes: [relayRoute('linked')] },
      { id: 'teammate', label: 'teammate', routes: [lanRoute('teammate'), tailscaleRoute('teammate')] },
    ], { teammate: false }, { teammate: keyOf('teammate') });

    connect('linked');
    connect('teammate');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(probes.filter(name => name === 'linked')).toEqual([]);
    expect(mine('linked')).toBe(false);
    expect(mine('teammate')).toBe(false);
  });

  it('side-checks once per connect, backs off after a failure, and checks a marked computer again only after 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
    try {
      const { mine, connect, drop, probes, keys } = own([{ id: 'macbook', label: 'macbook', routes: [lanRoute('macbook'), tailscaleRoute('macbook')] }], { macbook: true });
      const reconnect = async () => {
        drop('macbook');
        connect('macbook');
        await new Promise(resolve => setTimeout(resolve, 10));
      };
      // Unreachable over Tailscale: one try, then none until the backoff passes.
      await reconnect();
      expect(probes).toHaveLength(1);
      await reconnect();
      expect(probes).toHaveLength(1);

      keys.macbook = keyOf('macbook');
      vi.setSystemTime(new Date('2026-11-26T12:05:00.000Z'));
      await reconnect();
      expect(probes).toHaveLength(2);
      await vi.waitFor(() => expect(mine('macbook')).toBe(true));

      // Marked: not again for a day.
      await reconnect();
      expect(probes).toHaveLength(2);
      vi.setSystemTime(new Date('2026-11-27T12:06:00.000Z'));
      await reconnect();
      expect(probes).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks again on each connect over Tailscale, keeps the mark when Tailscale can\'t say or the connection is on another route', async () => {
    const { mine, connect, drop, checks, logins } = own([{ id: 'studio', label: 'studio', routes: [tailscaleRoute('studio'), relayRoute('studio')] }], { studio: true }, {}, { studio: keyOf('studio') });
    connect('studio');
    await vi.waitFor(() => expect(mine('studio')).toBe(true));

    logins.studio = undefined;
    drop('studio');
    connect('studio');
    await vi.waitFor(() => expect(checks).toHaveLength(2));
    expect(mine('studio')).toBe(true);

    // Over the relay, the peer's Tailscale identity is unknown: the mark proved on Tailscale stays.
    drop('studio');
    connect('studio', relayRoute('studio').id);
    await new Promise(resolve => setImmediate(resolve));
    expect(checks).toHaveLength(2);
    expect(mine('studio')).toBe(true);

    logins.studio = false;
    drop('studio');
    connect('studio');
    await vi.waitFor(() => expect(mine('studio')).toBe(false));
    expect(checks).toHaveLength(3);
  });

  it('checks when a live connection moves onto a Tailscale route', async () => {
    const { mine, connect } = own([{ id: 'studio', label: 'studio', routes: [relayRoute('studio'), tailscaleRoute('studio')] }], { studio: true });
    connect('studio');
    await new Promise(resolve => setImmediate(resolve));
    expect(mine('studio')).toBe(false);

    connect('studio', tailscaleRoute('studio').id);
    await vi.waitFor(() => expect(mine('studio')).toBe(true));
  });

  it('follows "This is my computer" over the Tailscale check, both ways', async () => {
    const { mine, change, connect } = own([
      { id: 'studio', label: 'studio', routes: [tailscaleRoute('studio')] },
      { id: 'linked', label: 'linked', routes: [relayRoute('linked')] },
    ], { studio: true });
    connect('studio');
    await vi.waitFor(() => expect(mine('studio')).toBe(true));

    change('linked', computer => ({ ...computer, mineOverride: true }));
    change('studio', computer => ({ ...computer, mineOverride: false }));

    expect(mine('linked')).toBe(true);
    expect(mine('studio')).toBe(false);
  });

  it("reads a chat's earlier messages only from your own machines (T-116 PR 6, D-19)", async () => {
    const { machines, mine, connect } = own([
      { id: 'linked', label: 'linked', mineOverride: true, routes: [relayRoute('linked')] },
      { id: 'teammate', label: 'teammate', routes: [relayRoute('teammate')] },
    ], {});
    connect('linked');
    connect('teammate');
    await vi.waitFor(() => expect(mine('linked')).toBe(true));

    await expect(machines.read('linked', 'chat-tab:history', ['chat-1', 100, 50])).resolves.toMatchObject({ machineId: 'linked' });
    await expect(machines.read('teammate', 'chat-tab:history', ['chat-1', 100, 50])).rejects.toMatchObject({ code: 'MACHINE_READ_OWNER_ONLY' });
  });

  it('never counts a computer it only watches as yours, whatever the switch says', async () => {
    const { mine } = own([{ id: 'shared', label: 'shared', mineOverride: true, mine: 'tailscale', routes: [tailscaleRoute('shared', 'pane_read_shared')] }], { shared: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(mine('shared')).toBe(false);
  });

  it('keeps no mark proved over a Tailscale name a teammate\'s host claimed once the connection moves to its relay (review MF-1, R1)', async () => {
    // The claimed route is dialed first: it reaches your real studio, which proves your login and holds studio's key.
    const claimed = { ...tailscaleRoute('studio'), id: 'tailscale:https://studio.tail1.ts.net:4800#claimed' };
    const { mine, connect, drop, saved } = own([{ id: 'mallory', label: 'mallory', routes: [claimed, relayRoute('mallory')] }], { studio: true }, { studio: keyOf('studio') }, { mallory: keyOf('studio') });
    connect('mallory', claimed.id);
    await vi.waitFor(() => expect(saved('mallory')?.mineRelay).toEqual(keyOf('studio')));
    expect(mine('mallory')).toBe(true);

    // Studio sleeps: the connection moves to the relay, which reaches the teammate's host and its own key.
    drop('mallory');
    connect('mallory', relayRoute('mallory').id);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mine('mallory')).toBe(false);
  });

  it('binds a Tailscale proof to the relay key read over that connection, and honours it on Same network only for that key', async () => {
    const { mine, connect, drop, saved } = own([{ id: 'macbook', label: 'macbook', routes: [lanRoute('macbook'), tailscaleRoute('macbook')] }], { macbook: true }, {}, { macbook: keyOf('macbook') });
    connect('macbook', tailscaleRoute('macbook').id);
    await vi.waitFor(() => expect(saved('macbook')?.mineRelay).toEqual(keyOf('macbook')));

    drop('macbook');
    connect('macbook', lanRoute('macbook').id);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mine('macbook')).toBe(true);
  });

  it('keeps the mark while the computer is offline, so its saved copy stays', async () => {
    const { mine, connect, drop } = own([{ id: 'studio', label: 'studio', routes: [tailscaleRoute('studio')] }], { studio: true }, {}, { studio: keyOf('studio') });
    connect('studio');
    await vi.waitFor(() => expect(mine('studio')).toBe(true));
    drop('studio');
    expect(mine('studio')).toBe(true);
  });

  it('after a side check proves a computer isn\'t yours, checks it again only a day later (review S-7)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
    try {
      const { connect, drop, probes } = own([{ id: 'teammate', label: 'teammate', routes: [lanRoute('teammate'), tailscaleRoute('teammate')] }], { teammate: false }, { teammate: keyOf('teammate') });
      const reconnect = async () => { drop('teammate'); connect('teammate'); await new Promise(resolve => setTimeout(resolve, 10)); };
      await reconnect();
      await reconnect();
      vi.setSystemTime(new Date('2026-11-27T11:00:00.000Z'));
      await reconnect();
      expect(probes).toHaveLength(1);
      vi.setSystemTime(new Date('2026-11-27T12:01:00.000Z'));
      await reconnect();
      expect(probes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
