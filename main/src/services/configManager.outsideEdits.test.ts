import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../../shared/validation/boundaryDecoder';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { ConfigManager } from './configManager';

// config.json edited outside Pane (by hand, a script, another agent) while Pane runs.
// Every Pane write re-reads the file and changes only the keys it means to change.

const HAND_OVERRIDES = { 'focus-sidebar': 'mod+e', 'focus-group-left': 'mod+shift+[' };

async function atomicHandEdit(configPath: string, edit: (c: JsonObject) => void) {
  const c = await onDisk(configPath);
  edit(c);
  const tmp = `${configPath}.hand.tmp`;
  await fs.writeFile(tmp, JSON.stringify(c, null, 2));
  await fs.rename(tmp, configPath);
}
const addKeys = (c: JsonObject) => {
  c.keyboardShortcutOverrides = { ...HAND_OVERRIDES };
  c.notify = { ...decodeBoundary(c.notify ?? {}, boundary.jsonObject), shortcut: 'Command+Shift+A' };
};
const onDisk = async (p: string) => decodeBoundary(JSON.parse(await fs.readFile(p, 'utf8')), boundary.jsonObject);

function nextConfigUpdate(manager: ConfigManager, matches: (c: AppConfig) => boolean = () => true): Promise<AppConfig> {
  return new Promise((resolve) => {
    const listener = (config: AppConfig) => {
      if (!matches(config)) return;
      manager.off('config-updated', listener);
      resolve(config);
    };
    manager.on('config-updated', listener);
  });
}

describe('ConfigManager keeps outside edits to config.json', () => {
  let dir: string;
  let configPath: string;
  let manager: ConfigManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-outside-edits-'));
    process.env.PANE_DIR = dir;
    configPath = path.join(dir, 'config.json');
    manager = new ConfigManager();
    await manager.initialize();
  });

  afterEach(async () => {
    manager.stopWatching();
    vi.restoreAllMocks();
    delete process.env.PANE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writers: Array<[string, (m: ConfigManager) => Promise<AppConfig | void>]> = [
    ['a no-op updateConfigWith (shared-credential / notify-switch apply)', m => m.updateConfigWith(() => ({}))],
    ['a remoteDaemon mode switch', m => m.updateConfig({ remoteDaemon: { ...m.getConfig().remoteDaemon!, client: { ...m.getConfig().remoteDaemon!.client, mode: 'local', activeProfileId: null } } })],
    ['the notify settings writer', m => m.updateConfig({ notify: { enabled: true } })],
    ['the paneSecrets index write', m => m.updateConfigWith(c => ({ paneSecrets: { ...c.paneSecrets } }))],
    ['the analytics identity save', m => m.setAnalyticsDistinctId('x')],
  ];

  for (const [name, write] of writers) {
    it(`keeps a hand edit Pane has not reloaded when ${name} saves`, async () => {
      await atomicHandEdit(configPath, addKeys);
      await write(manager);
      const disk = await onDisk(configPath);
      expect(disk.keyboardShortcutOverrides).toEqual(HAND_OVERRIDES);
      expect(disk.notify.shortcut).toBe('Command+Shift+A');
      expect(manager.getConfig().keyboardShortcutOverrides).toEqual(HAND_OVERRIDES);
    });
  }

  it('keeps a hand edit across a reload and a later write', async () => {
    await atomicHandEdit(configPath, addKeys);
    await manager.reloadFromDisk();
    await manager.updateConfigWith(() => ({}));
    const disk = await onDisk(configPath);
    expect(disk.keyboardShortcutOverrides).toEqual(HAND_OVERRIDES);
    expect(disk.notify.shortcut).toBe('Command+Shift+A');
  });

  it('keeps keys saved through updateConfig across a later background write', async () => {
    await manager.updateConfig({ keyboardShortcutOverrides: { 'focus-sidebar': 'mod+e' } });
    await manager.updateConfigWith(() => ({}));
    expect((await onDisk(configPath)).keyboardShortcutOverrides).toEqual({ 'focus-sidebar': 'mod+e' });
  });

  it('keeps saved keys across a machine switch', async () => {
    await manager.updateConfig({ keyboardShortcutOverrides: { 'focus-sidebar': 'mod+e' }, notify: { shortcut: 'Command+Shift+A' } });
    const rd = manager.getConfig().remoteDaemon!;
    await manager.updateConfig({ remoteDaemon: { ...rd, client: { ...rd.client, mode: 'local', activeProfileId: null } } });
    const disk = await onDisk(configPath);
    expect(disk.keyboardShortcutOverrides).toEqual({ 'focus-sidebar': 'mod+e' });
    expect(disk.notify.shortcut).toBe('Command+Shift+A');
  });

  it('keeps hand-edited overrides when a renderer copy from before the edit saves one key', async () => {
    const rendererCopy = await manager.reloadFromDisk();
    const staleOverrides = { ...(rendererCopy.keyboardShortcutOverrides ?? {}) };
    await atomicHandEdit(configPath, addKeys);
    // The CMD-K CMD-S save sends the whole map from the renderer's copy, without the hand-edited ids.
    await manager.updateConfig({ keyboardShortcutOverrides: { ...staleOverrides, 'cycle-tab-next-d': 'mod+alt+]' } });
    const disk = await onDisk(configPath);
    expect(disk.keyboardShortcutOverrides).toEqual({ ...HAND_OVERRIDES, 'cycle-tab-next-d': 'mod+alt+]' });
    expect(disk.notify.shortcut).toBe('Command+Shift+A');
  });

  it('still removes an override Pane resets, keeping the others', async () => {
    await atomicHandEdit(configPath, addKeys);
    await manager.reloadFromDisk();
    const { 'focus-sidebar': _reset, ...rest } = manager.getConfig().keyboardShortcutOverrides!;
    await manager.updateConfig({ keyboardShortcutOverrides: rest });
    expect((await onDisk(configPath)).keyboardShortcutOverrides).toEqual({ 'focus-group-left': 'mod+shift+[' });
  });

  it('lets the key Pane changes win over the disk value for that key only', async () => {
    await atomicHandEdit(configPath, c => { c.theme = 'forge'; c.highContrast = true; });
    await manager.updateConfig({ theme: 'dusk-oled' });
    const disk = await onDisk(configPath);
    expect(disk.theme).toBe('dusk-oled');
    expect(disk.highContrast).toBe(true);
  });

  it('merges one notify field onto the notify fields on disk', async () => {
    await atomicHandEdit(configPath, addKeys);
    await manager.updateConfig({ notify: { enabled: false } });
    expect((await onDisk(configPath)).notify).toMatchObject({ enabled: false, shortcut: 'Command+Shift+A' });
  });

  it('tells listeners when a reload finds an outside edit', async () => {
    let emitted: AppConfig | undefined;
    manager.on('config-updated', (config: AppConfig) => { emitted = config; });
    await atomicHandEdit(configPath, addKeys);
    await manager.reloadFromDisk();
    expect(emitted?.keyboardShortcutOverrides).toEqual(HAND_OVERRIDES);
    emitted = undefined;
    await manager.reloadFromDisk();
    expect(emitted).toBeUndefined();
  });

  it('keeps a hand edit that lands while a reload persists a migration', async () => {
    // Force a migration write on every reload: registerMcp missing.
    let lost = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const c = await onDisk(configPath);
      delete c.keyboardShortcutOverrides;
      const { registerMcp: _dropped, ...agentContext } = decodeBoundary(c.agentContext, boundary.jsonObject);
      c.agentContext = agentContext;
      await fs.writeFile(configPath, JSON.stringify(c, null, 2));
      await Promise.all([manager.reloadFromDisk(), atomicHandEdit(configPath, addKeys)]);
      if (!(await onDisk(configPath)).keyboardShortcutOverrides) lost++;
    }
    expect(lost).toBe(0);
  });

  it('reloads and tells listeners when the file changes while watching, ignoring its own writes', async () => {
    manager.startWatching();
    const listener = vi.fn();
    manager.on('config-updated', listener);
    await manager.updateConfig({ highContrast: true });
    expect(listener).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(listener).toHaveBeenCalledTimes(1);

    const reloaded = nextConfigUpdate(manager, c => c.keyboardShortcutOverrides !== undefined);
    await atomicHandEdit(configPath, addKeys);
    const config = await reloaded;
    expect(config.keyboardShortcutOverrides).toEqual(HAND_OVERRIDES);
    expect(manager.getConfig().notify?.shortcut).toBe('Command+Shift+A');
  });

  it('does not mistake the config it created on a fresh install for an outside edit', async () => {
    await fs.rm(configPath);
    const fresh = new ConfigManager();
    await fresh.initialize();
    const listener = vi.fn();
    fresh.on('config-updated', listener);
    fresh.startWatching();
    await fs.utimes(configPath, new Date(), new Date());
    await new Promise(resolve => setTimeout(resolve, 600));
    fresh.stopWatching();
    expect(listener).not.toHaveBeenCalled();
  });

  it('never overwrites a config.json that is not valid JSON, and saves once it is fixed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(configPath, '{ "theme": "forge", ');
    const updated = await manager.updateConfig({ highContrast: true });
    expect(updated.highContrast).toBe(true);
    expect(await fs.readFile(configPath, 'utf8')).toBe('{ "theme": "forge", ');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'), expect.anything());

    manager.startWatching();
    const saved = nextConfigUpdate(manager, c => c.keyboardShortcutOverrides !== undefined);
    await fs.writeFile(configPath, JSON.stringify({ theme: 'forge', keyboardShortcutOverrides: HAND_OVERRIDES }));
    await saved;
    await vi.waitFor(async () => {
      const disk = await onDisk(configPath);
      expect(disk).toMatchObject({ theme: 'forge', highContrast: true, keyboardShortcutOverrides: HAND_OVERRIDES });
    }, { timeout: 3000 });
  });
});
