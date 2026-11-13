import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(async () => {
    await Promise.all(running.splice(0).map(sync => sync.stop()));
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
    const sync = new SharedCredentialSync(configManager, {
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      remotes: () => peers,
    });
    running.push(sync);
    sync.start();
    const report = (event: MachineConnectionsEvent) => listeners.forEach(listener => listener(event));
    return { configManager, report };
  }

  /** Long enough for the debounce and any sync it sets off, so a loop would show. */
  const settled = () => new Promise(resolve => setTimeout(resolve, 1_300));

  it('keeps two real machines on one switch and one "Show cards on", in both directions, and settles', async () => {
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
    const syncs = [new SharedCredentialSync(a.configManager, reaching(b)), new SharedCredentialSync(b.configManager, reaching(a))];
    running.push(...syncs);
    syncs.forEach(sync => sync.start());
    await settled();

    await a.configManager.updateConfig({ notify: { enabled: false, position: 'top-right' } });
    await vi.waitFor(() => expect(b.configManager.getConfig().notify?.enabled).toBe(false), { timeout: 5_000 });
    expect(b.configManager.getConfig().notifyEnabledChangedAt).toBe(a.configManager.getConfig().notifyEnabledChangedAt);
    expect(b.configManager.getConfig().notify?.position).toBeUndefined();

    await b.configManager.updateConfig({ notify: { enabled: true } });
    await vi.waitFor(() => expect(a.configManager.getConfig().notify?.enabled).toBe(true), { timeout: 5_000 });
    await settled();

    await a.configManager.updateConfig({ notify: { cardsOn: MAC } });
    await vi.waitFor(() => expect(b.configManager.getConfig().notify?.cardsOn).toEqual(MAC), { timeout: 5_000 });
    expect(b.configManager.getConfig().notify?.enabled).toBe(true);
    await b.configManager.updateConfig({ notify: { cardsOn: null } });
    await vi.waitFor(() => expect(a.configManager.getConfig().notify?.cardsOn).toBeNull(), { timeout: 5_000 });
    await settled();

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
    await vi.waitFor(() => expect(configManager.getConfig().notify?.enabled).toBe(false), { timeout: 5_000 });

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
    await vi.waitFor(() => expect(configManager.getConfig().notify?.enabled).toBe(false), { timeout: 5_000 });

    await settled();
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
