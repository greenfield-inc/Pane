import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppServices } from './types';
import type { AppConfig } from '../types/config';
import { registerConfigHandlers } from './config';
import { registerSharedCredentialHandlers } from './sharedCredentials';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { ConfigManager } from '../services/configManager';
import { keychainSecretBackend, PaneSecretStore } from '../services/paneSecrets';
import { FakeKeychain } from '../test/fakeKeychain';
import type { SharedCredentials, SharedNotifySwitch } from '../../../shared/types/sharedCredentials';

const tempDirs: string[] = [];
const paired = { clientId: 'phone-1' };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function registerHost(existingConfig?: Partial<AppConfig>) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-shared-credentials-'));
  tempDirs.push(configDir);
  if (existingConfig) await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(existingConfig));
  vi.stubEnv('PANE_DIR', configDir);
  const configManager = new ConfigManager();
  await configManager.initialize();
  // SAFETY: These handlers read only configManager from the services bag.
  const services = { configManager, getMainWindow: () => null } as AppServices;
  const registry = new PaneCommandRegistry();
  const ipcMainStub: Pick<IpcMain, 'handle'> = { handle: () => undefined };
  // SAFETY: The config handlers use only ipcMain.handle, which the stub implements.
  registerConfigHandlers(ipcMainStub as IpcMain, services, registry);
  const keychain = new FakeKeychain();
  const secrets = new PaneSecretStore(configManager, keychainSecretBackend(keychain, 'Pane (test)'), () => 'this-mac');
  registerSharedCredentialHandlers(services, registry, secrets);
  // SAFETY: credentials:shared:* returns SharedCredentials.
  const read = async () => await registry.invokeRemote('credentials:shared:get', [null, paired]) as SharedCredentials;
  const apply = (credentials: SharedCredentials) => registry.invokeRemote('credentials:shared:apply', [credentials, paired]);
  return { configManager, registry, read, apply, secrets, keychain };
}

describe('shared credentials on a host', () => {
  it('reads a key set on this host with when and where it was set, and leaves env-only keys out', async () => {
    vi.stubEnv('FAL_KEY', 'fal-env-only-fake');
    const { registry, read } = await registerHost();
    const before = Date.now();

    await registry.invokeRemote('remote:settings:update', [{ deepgramApiKey: 'dg-fake-0123456789abcdef' }]);

    const credentials = await read();
    expect(credentials.deepgramApiKey?.value).toBe('dg-fake-0123456789abcdef');
    expect(credentials.deepgramApiKey?.source).toEqual(expect.any(String));
    expect(Date.parse(credentials.deepgramApiKey?.updatedAt ?? '')).toBeGreaterThanOrEqual(before);
    expect(credentials.falApiKey).toBeUndefined();
  });

  it('refuses to read or apply keys for a caller that is not a paired client', async () => {
    const { registry } = await registerHost();

    await expect(registry.invokeRemote('credentials:shared:get', [null])).rejects.toThrow();
    await expect(registry.invokeRemote('credentials:shared:apply', [{}])).rejects.toThrow();
  });

  it('takes a newer key from another host and keeps its own newer key', async () => {
    const { registry, configManager, read, apply } = await registerHost();
    await registry.invokeRemote('remote:settings:update', [{ deepgramApiKey: 'dg-local-0123456789abcdef' }]);

    await apply({
      deepgramApiKey: { value: 'dg-stale', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' },
      falApiKey: { value: 'fal-from-mac', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' },
    });

    expect(configManager.getConfig().deepgramApiKey).toBe('dg-local-0123456789abcdef');
    expect(configManager.getConfig().falApiKey).toBe('fal-from-mac');
    expect((await read()).falApiKey).toEqual({ value: 'fal-from-mac', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' });
  });

  it('keeps a cleared key cleared when an older copy arrives', async () => {
    const { configManager, read, apply } = await registerHost();
    const older = { value: 'fal-old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Windows' };
    await apply({ falApiKey: older });

    await apply({ falApiKey: { value: null, updatedAt: '2026-02-01T00:00:00.000Z', source: 'Mac' } });
    await apply({ falApiKey: older });

    expect(configManager.getConfig().falApiKey).toBeUndefined();
    expect((await read()).falApiKey).toEqual({ value: null, updatedAt: '2026-02-01T00:00:00.000Z', source: 'Mac' });
  });

  it('records a key removed in desktop settings as cleared', async () => {
    const { configManager, read } = await registerHost();
    await configManager.updateConfig({ openRouterApiKey: 'or-fake-1' });

    await configManager.updateConfig({ openRouterApiKey: undefined });

    expect((await read()).openRouterApiKey?.value).toBeNull();
  });

  it('replaces a key set before sharing existed with any timestamped copy', async () => {
    // A config written by an older Pane: the key has no record of when it was set.
    const { read, apply } = await registerHost({ anthropicApiKey: 'sk-ant-untimed' });
    expect((await read()).anthropicApiKey?.value).toBe('sk-ant-untimed');

    await apply({ anthropicApiKey: { value: 'sk-ant-new', updatedAt: '2020-01-01T00:00:00.000Z', source: 'Mac' } });

    expect((await read()).anthropicApiKey?.value).toBe('sk-ant-new');
  });

  it('shares a key edited by hand in config.json as newly set', async () => {
    const { configManager, read, apply } = await registerHost();
    await apply({ anthropicApiKey: { value: 'sk-ant-from-mac', updatedAt: '2026-01-01T00:00:00.000Z', source: 'Mac' } });
    const configPath = path.join(process.env.PANE_DIR ?? '', 'config.json');

    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(configPath, JSON.stringify({ ...onDisk, anthropicApiKey: 'sk-ant-hand-edited' }, null, 2));
    await configManager.reloadFromDisk();

    // Set on the Mac after its first copy but before the hand edit.
    await apply({ anthropicApiKey: { value: 'sk-ant-older', updatedAt: '2026-02-01T00:00:00.000Z', source: 'Mac' } });
    expect((await read()).anthropicApiKey?.value).toBe('sk-ant-hand-edited');
  });

  it('shares a hand edit of a key that was set before sharing existed', async () => {
    const { configManager, read } = await registerHost({ openaiApiKey: 'sk-openai-untimed' });
    const configPath = path.join(process.env.PANE_DIR ?? '', 'config.json');

    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(configPath, JSON.stringify({ ...onDisk, openaiApiKey: 'sk-openai-hand-edited' }, null, 2));
    await configManager.reloadFromDisk();

    const credentials = await read();
    expect(credentials.openaiApiKey?.value).toBe('sk-openai-hand-edited');
    expect(Date.parse(credentials.openaiApiKey?.updatedAt ?? '')).toBeGreaterThan(0);
  });

  it('shares Pane secrets with their values and takes newer ones, keeping values out of config.json', async () => {
    const { configManager, read, apply, secrets, keychain } = await registerHost();
    await secrets.set('stripe', 'STRIPE_KEY', 'sk_test_local_canary');

    const shared = (await read()).paneSecrets ?? {};
    expect(shared['stripe/STRIPE_KEY']).toEqual({ value: 'sk_test_local_canary', updatedAt: expect.any(String), source: 'this-mac' });

    await apply({ paneSecrets: {
      'qa/FROM_LINUX': { value: 'linux-value', updatedAt: '2026-01-01T00:00:00.000Z', source: 'linux-box' },
      'stripe/STRIPE_KEY': { value: 'older', updatedAt: '2020-01-01T00:00:00.000Z', source: 'linux-box' },
    } });

    expect(await secrets.read('qa', 'FROM_LINUX')).toBe('linux-value');
    expect(await secrets.read('stripe', 'STRIPE_KEY')).toBe('sk_test_local_canary');
    expect(keychain.get('Pane (test)', 'secret:qa/FROM_LINUX')).toBe('linux-value');
    const onDisk = await fs.readFile(path.join(process.env.PANE_DIR ?? '', 'config.json'), 'utf8');
    expect(onDisk).not.toContain('linux-value');
    expect(onDisk).not.toContain('sk_test_local_canary');
    expect(configManager.getConfig().paneSecrets?.['qa/FROM_LINUX']).toEqual({ updatedAt: '2026-01-01T00:00:00.000Z', source: 'linux-box' });
  });

  it('answers an apply without secret values, and syncs again without reading the keychain', async () => {
    const { read, apply, secrets, keychain } = await registerHost();
    await secrets.set('stripe', 'STRIPE_KEY', 'sk_test_local_canary');
    const answer = await apply({ paneSecrets: { 'qa/FROM_LINUX': { value: 'linux-value', updatedAt: '2026-01-01T00:00:00.000Z', source: 'linux-box' } } });
    expect(JSON.stringify(answer)).not.toMatch(/sk_test_local_canary|linux-value/);

    const reads = vi.spyOn(keychain, 'read');
    expect((await read()).paneSecrets).toMatchObject({
      'stripe/STRIPE_KEY': { value: 'sk_test_local_canary' },
      'qa/FROM_LINUX': { value: 'linux-value' },
    });
    expect(reads).not.toHaveBeenCalled();
  });

  it('keeps a deleted secret deleted on both sides when an older copy arrives', async () => {
    const { read, apply, secrets, keychain } = await registerHost();
    await apply({ paneSecrets: { 'qa/OLD': { value: 'old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'linux-box' } } });

    await secrets.delete('qa', 'OLD');
    await apply({ paneSecrets: { 'qa/OLD': { value: 'old', updatedAt: '2026-01-01T00:00:00.000Z', source: 'linux-box' } } });

    expect(secrets.has('qa', 'OLD')).toBe(false);
    expect(keychain.get('Pane (test)', 'secret:qa/OLD')).toBeUndefined();
    expect((await read()).paneSecrets?.['qa/OLD']).toEqual({ value: null, updatedAt: expect.any(String), source: 'this-mac' });

    await apply({ paneSecrets: { 'qa/OLD': { value: 'set-again', updatedAt: '2099-01-01T00:00:00.000Z', source: 'linux-box' } } });
    expect(await secrets.read('qa', 'OLD')).toBe('set-again');
  });

  it('drops secret records whose address is not a valid project/NAME', async () => {
    const { apply, secrets } = await registerHost();

    await apply({ paneSecrets: {
      'no-slash': { value: 'x', updatedAt: '2026-01-01T00:00:00.000Z', source: 'a' },
      'qa/PATH': { value: 'x', updatedAt: '2026-01-01T00:00:00.000Z', source: 'a' },
      'qa/pane_token': { value: 'x', updatedAt: '2026-01-01T00:00:00.000Z', source: 'a' },
      'qa/GOOD': { value: 'x', updatedAt: '2026-01-01T00:00:00.000Z', source: 'a' },
    } });

    expect(secrets.list().map(secret => `${secret.project}/${secret.name}`)).toEqual(['qa/GOOD']);
  });
});

describe('the Approvals switch on a host', () => {
  async function switchOf(existingConfig?: Partial<AppConfig>) {
    const host = await registerHost(existingConfig);
    // SAFETY: notify:switch:get returns SharedNotifySwitch.
    const read = async () => await host.registry.invokeRemote('notify:switch:get', [null, paired]) as SharedNotifySwitch;
    const apply = (incoming: SharedNotifySwitch) => host.registry.invokeRemote('notify:switch:apply', [incoming, paired]);
    return { ...host, readSwitch: read, applySwitch: apply };
  }

  it('reads as on, at time zero, when this host has never stored it', async () => {
    const { readSwitch } = await switchOf();

    expect(await readSwitch()).toMatchObject({ enabled: true, changedAt: 0 });
  });

  it('reads an off stored before the switch was shared as off, at time zero, so any timed value replaces it', async () => {
    const { readSwitch, applySwitch } = await switchOf({ notify: { enabled: false } });

    expect(await readSwitch()).toMatchObject({ enabled: false, changedAt: 0 });

    await applySwitch({ enabled: true, changedAt: 1 });
    expect(await readSwitch()).toMatchObject({ enabled: true, changedAt: 1 });
  });

  it('refuses a caller that is not a paired client', async () => {
    const { registry } = await switchOf();

    await expect(registry.invokeRemote('notify:switch:get', [null])).rejects.toThrow();
    await expect(registry.invokeRemote('notify:switch:apply', [{ enabled: false, changedAt: 1 }])).rejects.toThrow();
  });

  it('stamps a change made on this host, once, and leaves the time alone for other Approvals settings', async () => {
    const { configManager, readSwitch } = await switchOf();
    const before = Date.now();

    await configManager.updateConfig({ notify: { enabled: false } });
    const stamped = await readSwitch();
    expect(stamped.enabled).toBe(false);
    expect(stamped.changedAt).toBeGreaterThanOrEqual(before);

    await configManager.updateConfig({ notify: { enabled: false } });
    await configManager.updateConfig({ notify: { position: 'top-right', sound: false } });
    await configManager.updateConfig({ preferredShell: 'auto' });
    expect(await readSwitch()).toEqual(stamped);
  });

  it('wins over a time ahead of this host\'s clock when the person changes it here', async () => {
    const future = Date.now() + 3_600_000;
    const { configManager, readSwitch, applySwitch } = await switchOf();
    await applySwitch({ enabled: false, changedAt: future });

    await configManager.updateConfig({ notify: { enabled: true } });

    expect(await readSwitch()).toMatchObject({ enabled: true, changedAt: future + 1 });
  });

  it('takes a newer value with that host\'s time, turns off through config-updated, and keeps per-machine settings', async () => {
    const { configManager, readSwitch, applySwitch } = await switchOf();
    await configManager.updateConfig({ notify: { position: 'top-right', sound: false } });
    const updates: AppConfig[] = [];
    configManager.on('config-updated', (config: AppConfig) => updates.push(config));

    await applySwitch({ enabled: false, changedAt: 5_000 });

    expect(await readSwitch()).toMatchObject({ enabled: false, changedAt: 5_000 });
    expect(updates.at(-1)?.notify).toEqual({ enabled: false, position: 'top-right', sound: false });
  });

  it('keeps its own value when an older one arrives, and writes nothing', async () => {
    const { configManager, readSwitch, applySwitch } = await switchOf({ notify: { enabled: false }, notifyEnabledChangedAt: 5_000 });

    await applySwitch({ enabled: true, changedAt: 4_000 });

    expect(await readSwitch()).toMatchObject({ enabled: false, changedAt: 5_000 });
    expect(configManager.getConfig().notify?.enabled).toBe(false);
  });

  it('settles equal times on off without changing the time', async () => {
    const { readSwitch, applySwitch } = await switchOf();

    await applySwitch({ enabled: false, changedAt: 0 });

    expect(await readSwitch()).toMatchObject({ enabled: false, changedAt: 0 });
  });

  it('refuses a malformed value and changes nothing', async () => {
    const { readSwitch, registry } = await switchOf();

    await expect(registry.invokeRemote('notify:switch:apply', [{ enabled: 'off', changedAt: 5 }, paired])).rejects.toThrow();

    expect(await readSwitch()).toMatchObject({ enabled: true, changedAt: 0 });
  });

  it('counts a hand edit of config.json as changed now, so an older copy cannot undo it', async () => {
    const { configManager, readSwitch, applySwitch } = await switchOf({ notify: { enabled: true }, notifyEnabledChangedAt: 5_000 });
    const configPath = path.join(process.env.PANE_DIR ?? '', 'config.json');

    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8'));
    await fs.writeFile(configPath, JSON.stringify({ ...onDisk, notify: { enabled: false } }, null, 2));
    await configManager.reloadFromDisk();

    await applySwitch({ enabled: true, changedAt: 5_001 });
    const current = await readSwitch();
    expect(current.enabled).toBe(false);
    expect(current.changedAt).toBeGreaterThan(5_001);
  });

  it('stamps a "Show cards on" picked here, and keeps it when a host from before it sends a newer switch', async () => {
    const { configManager, readSwitch, applySwitch } = await switchOf();
    const before = Date.now();
    const book = { id: 'c3d4-book', name: 'qa-macbook' };

    await configManager.updateConfig({ notify: { cardsOn: book } });
    const picked = await readSwitch();
    expect(picked).toMatchObject({ enabled: true, changedAt: 0, cardsOn: book });
    expect(picked.cardsOnChangedAt).toBeGreaterThanOrEqual(before);

    await applySwitch({ enabled: false, changedAt: before + 60_000 });
    expect(await readSwitch()).toEqual({ enabled: false, changedAt: before + 60_000, cardsOn: book, cardsOnChangedAt: picked.cardsOnChangedAt });
  });

  it('takes a newer "Show cards on" with that host\'s time and leaves the switch alone', async () => {
    const { configManager, readSwitch, applySwitch } = await switchOf({ notify: { enabled: false }, notifyEnabledChangedAt: 5_000 });

    await applySwitch({ enabled: true, changedAt: 4_000, cardsOn: { id: 'a1b2-mini', name: 'mini' }, cardsOnChangedAt: 6_000 });

    expect(await readSwitch()).toEqual({ enabled: false, changedAt: 5_000, cardsOn: { id: 'a1b2-mini', name: 'mini' }, cardsOnChangedAt: 6_000 });
    expect(configManager.getConfig().notifyCardsOnChangedAt).toBe(6_000);
  });

  it('does not treat loading a saved value at startup as a change', async () => {
    const { readSwitch, configManager } = await switchOf({ notify: { enabled: false } });

    await configManager.reloadFromDisk();

    expect(await readSwitch()).toMatchObject({ enabled: false, changedAt: 0 });
  });
});
