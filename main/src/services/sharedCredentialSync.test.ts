import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';
import { sharedCredentialsSchema, sharedNotifySwitchSchema } from './sharedCredentials';
import { SharedCredentialSync } from './sharedCredentialSync';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { registerSharedCredentialHandlers } from '../ipc/sharedCredentials';
import { keychainSecretBackend, PaneSecretStore } from './paneSecrets';
import { FakeKeychain } from '../test/fakeKeychain';
import type { AppServices } from '../ipc/types';
import { PaneError } from '../../../shared/paneError';
import {
  mergeNotifySwitch,
  mergeSharedCredentials,
  syncSharedCredentials,
  syncSharedNotifySwitch,
  type SharedCredentialHost,
  type SharedCredentials,
  type SharedNotifySwitch,
  type SharedNotifySwitchHost,
} from '../../../shared/types/sharedCredentials';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import { decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { AppConfig } from '../types/config';

const sent = vi.fn();

function host(initial: SharedCredentials) {
  let credentials = initial;
  let applies = 0;
  const endpoint: SharedCredentialHost = {
    read: async () => credentials,
    apply: async (incoming) => {
      applies += 1;
      credentials = mergeSharedCredentials(credentials, incoming).credentials;
    },
  };
  return { endpoint, current: () => credentials, applies: () => applies };
}

const offline: SharedCredentialHost = {
  read: async () => { throw new Error('connect ECONNREFUSED'); },
  apply: async () => { throw new Error('connect ECONNREFUSED'); },
};

describe('syncSharedCredentials', () => {
  it('gives every reachable host the newest copy of each key and skips hosts it cannot reach', async () => {
    const mac = host({
      deepgramApiKey: { value: 'dg-new', updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      falApiKey: { value: null, updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
    });
    const windows = host({
      deepgramApiKey: { value: 'dg-old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Windows' },
      falApiKey: { value: 'fal-old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Windows' },
      openRouterApiKey: { value: 'or-win', updatedAt: '2026-02-01T00:00:00.000Z', source: 'Windows' },
    });

    const result = await syncSharedCredentials([mac.endpoint, offline, windows.endpoint]);

    const expected = {
      deepgramApiKey: { value: 'dg-new', updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      falApiKey: { value: null, updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      openRouterApiKey: { value: 'or-win', updatedAt: '2026-02-01T00:00:00.000Z', source: 'Windows' },
    };
    expect(mac.current()).toEqual(expected);
    expect(windows.current()).toEqual(expected);
    expect(result).toEqual({ reached: 2, updated: 2 });
  });

  it('writes nothing when every host already agrees', async () => {
    const same = { anthropicApiKey: { value: 'sk-ant-1', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Mac' } };
    const mac = host(same);
    const windows = host(same);

    await syncSharedCredentials([mac.endpoint, windows.endpoint]);

    expect(mac.applies() + windows.applies()).toBe(0);
  });

  it('carries Pane secrets the same way: newest wins, a deletion stays deleted, and a host that agrees gets no write', async () => {
    const mac = host({ paneSecrets: {
      'stripe/STRIPE_KEY': { value: 'sk_new', updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      'qa/OLD': { value: null, updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
    } });
    const linux = host({ paneSecrets: {
      'stripe/STRIPE_KEY': { value: 'sk_old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'linux-box' },
      'qa/OLD': { value: 'still-here', updatedAt: '2026-02-01T00:00:00.000Z', source: 'linux-box' },
      'qa/ONLY_LINUX': { value: 'l', updatedAt: '2026-02-01T00:00:00.000Z', source: 'linux-box' },
    } });

    await syncSharedCredentials([mac.endpoint, linux.endpoint]);

    const expected = { paneSecrets: {
      'stripe/STRIPE_KEY': { value: 'sk_new', updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      'qa/OLD': { value: null, updatedAt: '2026-03-01T00:00:00.000Z', source: 'Mac' },
      'qa/ONLY_LINUX': { value: 'l', updatedAt: '2026-02-01T00:00:00.000Z', source: 'linux-box' },
    } };
    expect(mac.current()).toEqual(expected);
    expect(linux.current()).toEqual(expected);

    const applied = mac.applies() + linux.applies();
    await syncSharedCredentials([mac.endpoint, linux.endpoint]);
    expect(mac.applies() + linux.applies()).toBe(applied);
  });
});

function switchHost(initial: SharedNotifySwitch) {
  let current = initial;
  const applied: SharedNotifySwitch[] = [];
  const endpoint: SharedNotifySwitchHost = {
    read: async () => current,
    apply: async (incoming) => {
      applied.push(incoming);
      current = mergeNotifySwitch(current, incoming).notifySwitch;
    },
  };
  return { endpoint, current: () => current, applied };
}

/** A host with the switch but from before "Show cards on": its decoder drops the new fields. */
function switchOnlyHost(initial: SharedNotifySwitch) {
  const host = switchHost(initial);
  const apply = host.endpoint.apply;
  host.endpoint.apply = async ({ enabled, changedAt }) => apply({ enabled, changedAt });
  return host;
}

const MAC = { id: '6f1c2a40-mac', name: 'Parsa-MacBook' };

const olderBuild: SharedNotifySwitchHost = {
  read: async () => { throw new PaneError('ERR_UNKNOWN_CHANNEL', 'No Pane daemon command registered.', 'Update Pane.'); },
  apply: async () => { throw new Error('a host too old to share the switch must never be written to'); },
};

describe('syncSharedNotifySwitch', () => {
  it('gives every reachable host the newest value with its time, and skips hosts it cannot reach', async () => {
    const mac = switchHost({ enabled: false, changedAt: 2_000 });
    const windows = switchHost({ enabled: true, changedAt: 1_000 });

    const result = await syncSharedNotifySwitch([mac.endpoint, olderBuild, windows.endpoint]);

    expect(windows.current()).toEqual({ enabled: false, changedAt: 2_000 });
    expect(mac.applied).toEqual([]);
    expect(result).toEqual({ reached: 2, updated: 1 });
  });

  it('turns a host back on when on is the newer value', async () => {
    const mac = switchHost({ enabled: false, changedAt: 1_000 });
    const windows = switchHost({ enabled: true, changedAt: 2_000 });

    await syncSharedNotifySwitch([mac.endpoint, windows.endpoint]);

    expect(mac.current()).toEqual({ enabled: true, changedAt: 2_000 });
  });

  it('writes nothing when every host already agrees', async () => {
    const mac = switchHost({ enabled: false, changedAt: 2_000 });
    const windows = switchHost({ enabled: false, changedAt: 2_000 });

    await syncSharedNotifySwitch([mac.endpoint, windows.endpoint]);

    expect(mac.applied.length + windows.applied.length).toBe(0);
  });

  it('takes the switch and "Show cards on" each from the host that changed it last', async () => {
    const mac = switchHost({ enabled: false, changedAt: 2_000, cardsOn: null, cardsOnChangedAt: 1_000 });
    const windows = switchHost({ enabled: true, changedAt: 1_000, cardsOn: MAC, cardsOnChangedAt: 3_000 });

    await syncSharedNotifySwitch([mac.endpoint, windows.endpoint]);

    const expected = { enabled: false, changedAt: 2_000, cardsOn: MAC, cardsOnChangedAt: 3_000 };
    expect(mac.current()).toEqual(expected);
    expect(windows.current()).toEqual(expected);
  });

  it('keeps a pick when a host from before "Show cards on" has the newer switch, and still syncs on/off with it', async () => {
    const old = switchOnlyHost({ enabled: false, changedAt: 5_000 });
    const mac = switchHost({ enabled: true, changedAt: 1_000, cardsOn: MAC, cardsOnChangedAt: 2_000 });

    await syncSharedNotifySwitch([old.endpoint, mac.endpoint]);

    expect(mac.current()).toEqual({ enabled: false, changedAt: 5_000, cardsOn: MAC, cardsOnChangedAt: 2_000 });
    expect(old.applied).toEqual([]);

    await syncSharedNotifySwitch([old.endpoint, mac.endpoint]);
    expect(old.applied.length + mac.applied.length).toBe(1);
  });

  it('settles a "Show cards on" tie on whichever computer is in use, whatever order hosts are read in', async () => {
    const picked = switchHost({ enabled: true, changedAt: 0, cardsOn: MAC, cardsOnChangedAt: 4_000 });
    const anyComputer = switchHost({ enabled: true, changedAt: 0, cardsOn: null, cardsOnChangedAt: 4_000 });

    await syncSharedNotifySwitch([picked.endpoint, anyComputer.endpoint]);
    await syncSharedNotifySwitch([anyComputer.endpoint, picked.endpoint]);

    expect(picked.current().cardsOn).toBeNull();
    expect(anyComputer.current().cardsOn).toBeNull();
  });

  it.each([
    ['first', [{ enabled: false, changedAt: 0 }, { enabled: true, changedAt: 0 }]],
    ['last', [{ enabled: true, changedAt: 0 }, { enabled: false, changedAt: 0 }]],
  ])('settles a tie on off wherever the off host sits (%s), so hosts never trade values', async (_position, values) => {
    const [one, two] = values.map(switchHost);

    await syncSharedNotifySwitch([one.endpoint, two.endpoint]);
    await syncSharedNotifySwitch([two.endpoint, one.endpoint]);

    expect(one.current()).toEqual({ enabled: false, changedAt: 0 });
    expect(two.current()).toEqual({ enabled: false, changedAt: 0 });
  });
});

/** What a value looks like after a machine's connection carried it. */
const overTheWire = (value: SharedCredentials | SharedNotifySwitch | PaneCommandValue): JsonValue => JSON.parse(JSON.stringify(value));

/** A saved machine as the desktop's connection sees it. `older` has no switch commands, like a build from before this one. */
function machine(id: string, initial: SharedNotifySwitch | 'older', credentials: SharedCredentials = {}) {
  let current = initial;
  let keys = credentials;
  const invoke = vi.fn(async (channel: string, args: unknown[]): Promise<JsonValue | undefined> => {
    if (channel === 'credentials:shared:get') return overTheWire(keys);
    if (channel === 'credentials:shared:apply') {
      keys = mergeSharedCredentials(keys, decodeBoundary(args[0], sharedCredentialsSchema)).credentials;
      return overTheWire(keys);
    }
    if (current === 'older') throw new PaneError('ERR_UNKNOWN_CHANNEL', `No Pane daemon command registered for channel "${channel}".`, 'Update Pane.');
    if (channel === 'notify:switch:get') return overTheWire(current);
    if (channel === 'notify:switch:apply') {
      current = mergeNotifySwitch(current, decodeBoundary(args[0], sharedNotifySwitchSchema)).notifySwitch;
      return overTheWire(current);
    }
    throw new Error(`unexpected channel ${channel}`);
  });
  const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel);
  const set = (next: SharedNotifySwitch | 'older') => { current = next; };
  return { id, invoke, calls, set, current: () => current, keys: () => keys };
}

describe('SharedCredentialSync and the Approvals switch', () => {
  const dirs: string[] = [];
  const running: SharedCredentialSync[] = [];
  /** Every sync the debounce has started and not yet been waited for. */
  const runs: Array<Promise<void>> = [];

  /** Records every sync the debounce starts, so a test waits for syncs to end instead of for wall time. */
  class TrackedSync extends SharedCredentialSync {
    protected override run(): Promise<void> {
      const started = super.run();
      runs.push(started);
      return started;
    }
  }

  beforeEach(() => {
    // The 500 ms debounce runs on a fake clock; config files, keys and peers stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map(sync => sync.stop()));
    await Promise.all(runs.splice(0));
    vi.useRealTimers();
    resetPaneRuntimeForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    sent.mockClear();
    await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  });

  async function start(peers: Array<ReturnType<typeof machine>>, config?: Partial<AppConfig>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-switch-sync-'));
    dirs.push(dir);
    if (config) await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
    vi.stubEnv('PANE_DIR', dir);
    const configManager = new ConfigManager();
    await configManager.initialize();
    setPaneRuntime({
      eventSink: { send: sent },
      getConfigManager: () => configManager,
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });
    const listeners = new Set<(event: MachineConnectionsEvent) => void>();
    const sync = new TrackedSync(configManager, {
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      remotes: () => peers,
    });
    running.push(sync);
    sync.start();
    const report = (event: MachineConnectionsEvent) => listeners.forEach(listener => listener(event));
    return { configManager, report };
  }

  /**
   * Runs out the debounce and every sync it sets off, until a debounce passes with no sync. Machines
   * that trade values back and forth never get there, so a loop fails here.
   */
  const settled = async () => {
    for (let round = 0; round < 10; round += 1) {
      await vi.advanceTimersByTimeAsync(1_300);
      const started = runs.splice(0);
      if (started.length === 0) return;
      await Promise.all(started);
    }
    throw new Error('Each sync set off another for 10 rounds: the machines keep trading values.');
  };

  it('keeps two real machines on one switch, one "Show cards on" and one machine health Notifications switch, in both directions, and settles', async () => {
    const hostFor = async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-switch-sync-'));
      dirs.push(dir);
      vi.stubEnv('PANE_DIR', dir);
      const configManager = new ConfigManager();
      await configManager.initialize();
      const registry = new PaneCommandRegistry();
      const secrets = new PaneSecretStore(configManager, keychainSecretBackend(new FakeKeychain(), 'Pane (test)'), () => 'this-mac');
      // SAFETY: These handlers read only configManager from the services bag.
      registerSharedCredentialHandlers({ configManager } as AppServices, registry, secrets);
      return { configManager, registry };
    };
    const a = await hostFor();
    const b = await hostFor();
    const reaching = (other: typeof a) => ({
      subscribe: () => () => undefined,
      remotes: () => [{
        id: 'other',
        invoke: async (channel: string, args: unknown[]) => {
          const input: PaneCommandValue = JSON.parse(JSON.stringify(args[0] ?? null));
          return overTheWire(await other.registry.invokeRemote(channel, [input, { clientId: 'paired' }]));
        },
      }],
    });
    const syncs = [new TrackedSync(a.configManager, reaching(b)), new TrackedSync(b.configManager, reaching(a))];
    running.push(...syncs);
    syncs.forEach(sync => sync.start());
    await settled();

    await a.configManager.updateConfig({ notify: { enabled: false, position: 'top-right' } });
    await settled();
    expect(b.configManager.getConfig().notify?.enabled).toBe(false);
    expect(b.configManager.getConfig().notifyEnabledChangedAt).toBe(a.configManager.getConfig().notifyEnabledChangedAt);
    expect(b.configManager.getConfig().notify?.position).toBeUndefined();

    await b.configManager.updateConfig({ notify: { enabled: true } });
    await settled();
    expect(a.configManager.getConfig().notify?.enabled).toBe(true);
    await settled();

    await a.configManager.updateConfig({ notify: { cardsOn: MAC } });
    await settled();
    expect(b.configManager.getConfig().notify?.cardsOn).toEqual(MAC);
    expect(b.configManager.getConfig().notify?.enabled).toBe(true);
    await b.configManager.updateConfig({ notify: { cardsOn: null } });
    await settled();
    expect(a.configManager.getConfig().notify?.cardsOn).toBeNull();
    await settled();

    await a.configManager.updateConfig({ machineHealth: { notifications: false } });
    await settled();
    expect(b.configManager.getConfig().machineHealth?.notifications).toBe(false);
    expect(b.configManager.getConfig().notify?.enabled).toBe(true);
    await b.configManager.updateConfig({ machineHealth: { notifications: true, diskWarningGB: 30 } });
    await settled();
    expect(a.configManager.getConfig().machineHealth?.notifications).toBe(true);
    // Only the switch travels; thresholds stay on each machine.
    expect(a.configManager.getConfig().machineHealth?.diskWarningGB).toBeUndefined();
    await settled();
    expect(b.configManager.getConfig().machineHealthNotificationsChangedAt).toBe(a.configManager.getConfig().machineHealthNotificationsChangedAt);

    const stamp = a.configManager.getConfig().notifyEnabledChangedAt;
    expect(b.configManager.getConfig().notifyEnabledChangedAt).toBe(stamp);
    expect(b.configManager.getConfig().notifyCardsOnChangedAt).toBe(a.configManager.getConfig().notifyCardsOnChangedAt);
    const writes = vi.fn();
    a.configManager.on('config-updated', writes);
    b.configManager.on('config-updated', writes);
    await settled();
    expect(writes).not.toHaveBeenCalled();
  }, 30_000);

  it('sends a local turn-off to a machine that is behind, carrying this machine\'s time', async () => {
    const peer = machine('build-box', { enabled: true, changedAt: 0 });
    const { configManager } = await start([peer]);
    const before = Date.now();

    await configManager.updateConfig({ notify: { enabled: false } });
    await vi.waitFor(() => expect(peer.current()).toMatchObject({ enabled: false }), { timeout: 5_000 });

    expect(peer.current()).toMatchObject({ enabled: false, changedAt: configManager.getConfig().notifyEnabledChangedAt });
    expect(configManager.getConfig().notifyEnabledChangedAt).toBeGreaterThanOrEqual(before);
  });

  it('applies a newer off from a machine that reports a settings change, with that machine\'s time and no re-stamp', async () => {
    const peer = machine('build-box', { enabled: true, changedAt: 0 });
    const { configManager, report } = await start([peer]);
    await settled();
    const updates: AppConfig[] = [];
    configManager.on('config-updated', (config: AppConfig) => updates.push(config));

    peer.set({ enabled: false, changedAt: 5_000 });
    report({ type: 'event', machineId: 'build-box', channel: 'remote:settings-changed', args: [] });
    await settled();
    expect(configManager.getConfig().notify?.enabled).toBe(false);

    // NotifyService turns off on this same event, as it does for a local toggle.
    expect(updates.at(-1)?.notify?.enabled).toBe(false);
    expect(configManager.getConfig().notifyEnabledChangedAt).toBe(5_000);
    await settled();
    expect(peer.calls('notify:switch:apply')).toEqual([]);
  });

  it('catches up when a saved machine reconnects', async () => {
    const peer = machine('build-box', { enabled: true, changedAt: 0 });
    const { configManager, report } = await start([peer]);
    await settled();

    peer.set({ enabled: false, changedAt: 5_000 });
    report({ type: 'resync', machineId: 'build-box' });

    await vi.waitFor(() => expect(configManager.getConfig().notify?.enabled).toBe(false), { timeout: 5_000 });
  });

  it('does not trade values back and forth once machines agree', async () => {
    const peer = machine('build-box', { enabled: false, changedAt: 5_000 });
    const { configManager } = await start([peer]);
    await settled();
    expect(configManager.getConfig().notify?.enabled).toBe(false);

    const reads = peer.calls('notify:switch:get').length;
    await settled();

    expect(peer.calls('notify:switch:apply')).toEqual([]);
    expect(peer.calls('notify:switch:get').length).toBe(reads);
  });

  it('skips a machine on an older build without a warning, and still shares keys with it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const peer = machine('old-box', 'older');
    const { configManager } = await start([peer], { notify: { enabled: false }, notifyEnabledChangedAt: 5_000 });

    await configManager.updateConfig({ deepgramApiKey: 'dg-fake-0123456789abcdef' });
    await vi.waitFor(() => expect(peer.keys().deepgramApiKey?.value).toBe('dg-fake-0123456789abcdef'), { timeout: 5_000 });
    await settled();

    expect(peer.calls('notify:switch:apply')).toEqual([]);
    expect(configManager.getConfig().notify?.enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('shares only on/off: position, sound and shortcut stay on each machine', async () => {
    const peer = machine('build-box', { enabled: true, changedAt: 0 });
    const { configManager } = await start([peer]);
    await settled();
    sent.mockClear();
    peer.invoke.mockClear();

    await configManager.updateConfig({ notify: { position: 'top-right', sound: false, shortcut: 'Control+Shift+K' } });
    await settled();

    expect(peer.invoke).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(configManager.getConfig().notifyEnabledChangedAt).toBeUndefined();
  });

  it('tells machines that saved this one when the switch changes, even from the tray', async () => {
    const { configManager } = await start([]);
    await settled();
    sent.mockClear();

    // The tray and Settings both end here; only Settings reports the change itself.
    await configManager.updateConfig({ notify: { enabled: false } });

    expect(sent).toHaveBeenCalledWith('remote:settings-changed');
  });
});

describe('1Password references in sync', () => {
  const reference = { value: 'op://Dev/Stripe/credential', updatedAt: '2026-11-18T12:00:00.000Z', source: 'studio' };
  const typed = { value: 'typed-value', updatedAt: '2026-11-01T00:00:00.000Z', source: 'studio' };
  /** A host from before references: its decoder drops the field, both ways. */
  function olderHost(initial: SharedCredentials) {
    const inner = host(initial);
    const drop = ({ paneSecretReferences: _dropped, ...rest }: SharedCredentials): SharedCredentials => rest;
    return { ...inner, endpoint: { read: async () => drop(await inner.endpoint.read()), apply: (incoming: SharedCredentials) => inner.endpoint.apply(drop(incoming)) } };
  }

  it('reaches every newer host, and an older host neither stores it nor reads it as a deletion', async () => {
    const mac = host({ paneSecrets: { 'qa/TOKEN': typed }, paneSecretReferences: { 'stripe/STRIPE_KEY': reference } });
    const devbox = host({});
    const old = olderHost({ paneSecrets: { 'qa/TOKEN': typed } });

    await syncSharedCredentials([mac.endpoint, devbox.endpoint, old.endpoint]);

    expect(devbox.current().paneSecretReferences).toEqual({ 'stripe/STRIPE_KEY': reference });
    expect(old.current()).toEqual({ paneSecrets: { 'qa/TOKEN': typed } });
  });

  it('is never lost when an older desktop or phone relays sync between two newer hosts', async () => {
    const mac = host({ paneSecretReferences: { 'stripe/STRIPE_KEY': reference } });
    const devbox = host({ paneSecretReferences: {} });
    // An older relay merges only what it knows, so it hands each host a copy without references.
    const strip = (endpoint: SharedCredentialHost): SharedCredentialHost => ({
      read: async () => {
        const { paneSecretReferences: _dropped, ...rest } = await endpoint.read();
        return rest;
      },
      apply: endpoint.apply,
    });

    await syncSharedCredentials([strip(mac.endpoint), strip(devbox.endpoint)]);

    expect(mac.current().paneSecretReferences).toEqual({ 'stripe/STRIPE_KEY': reference });
    expect(devbox.current().paneSecretReferences).toEqual({});
  });
});

describe('key sharing handlers', () => {
  const gateDirs: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(gateDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  });

  it('answer only paired devices, and ignore a reference stamped in the future', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-shared-gate-'));
    gateDirs.push(dir);
    vi.stubEnv('PANE_DIR', dir);
    const configManager = new ConfigManager();
    await configManager.initialize();
    const registry = new PaneCommandRegistry();
    const secrets = new PaneSecretStore(configManager, keychainSecretBackend(new FakeKeychain(), 'Pane (test)'), () => 'this-mac');
    // SAFETY: These handlers read only configManager from the services bag.
    registerSharedCredentialHandlers({ configManager } as AppServices, registry, secrets);
    const planted = { paneSecretReferences: { 'stripe/STRIPE_KEY': { value: 'op://Private/Bank/password', updatedAt: '2099-01-01T00:00:00.000Z', source: 'devbox' } } };

    // A program on this machine passes its own "trusted" argument over the local socket: refused.
    await expect(registry.invoke('credentials:shared:get', [{}, { clientId: 'forged' }])).rejects.toMatchObject({ code: 'SECRET_REMOTE_ONLY' });
    await expect(registry.invoke('credentials:shared:apply', [planted, { clientId: 'forged' }])).rejects.toMatchObject({ code: 'SECRET_REMOTE_ONLY' });

    await registry.invokeRemote('credentials:shared:apply', [planted, { clientId: 'paired' }]);
    expect(secrets.listReferences()).toEqual([]);
  });
});
