import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';

describe('ConfigManager appearance persistence', () => {
  let paneDir: string;
  let configPath: string;

  beforeEach(async () => {
    paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-appearance-'));
    process.env.PANE_DIR = paneDir;
    configPath = path.join(paneDir, 'config.json');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env.PANE_DIR;
    await fs.rm(paneDir, { recursive: true, force: true });
  });

  it('writes new-install defaults', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig()).toMatchObject({
      appearanceMode: 'system', theme: 'light-rounded', systemLightTheme: 'light-rounded', systemDarkTheme: 'dark',
    });
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toMatchObject({
      appearanceMode: 'system', theme: 'light-rounded', systemLightTheme: 'light-rounded', systemDarkTheme: 'dark',
      analytics: { enabled: true },
    });
  });

  it('preserves an existing analytics opt-out', async () => {
    await fs.writeFile(configPath, JSON.stringify({ analytics: { enabled: false } }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig().analytics?.enabled).toBe(false);
  });

  it('migrates a legacy theme once', async () => {
    await fs.writeFile(configPath, JSON.stringify({ theme: 'forge' }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig()).toMatchObject({ appearanceMode: 'fixed', theme: 'forge', systemLightTheme: 'light-rounded', systemDarkTheme: 'forge' });
    const first = await fs.stat(configPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.initialize();
    expect((await fs.stat(configPath)).mtimeMs).toBe(first.mtimeMs);
  });

  it('repairs corrupt slots, preserves valid fields, and logs a diagnostic', async () => {
    await fs.writeFile(configPath, JSON.stringify({ appearanceMode: 'system', theme: 'abyss', systemLightTheme: 'dark', systemDarkTheme: 'forge' }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig()).toMatchObject({ theme: 'abyss', systemLightTheme: 'light-rounded', systemDarkTheme: 'forge' });
    expect(console.error).toHaveBeenCalledWith('[ConfigManager] appearance: invalid systemLightTheme; restored light-rounded');
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).systemLightTheme).toBe('light-rounded');
  });

  it('serializes concurrent updates without losing either change', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    await Promise.all([manager.updateConfig({ theme: 'forge' }), manager.updateConfig({ highContrast: true })]);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toMatchObject({ theme: 'forge', highContrast: true });
  });

  it('serializes reloads behind in-flight updates', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const realRename = fs.rename.bind(fs);
    let releaseRename: (() => void) | undefined;
    const renameBlocked = new Promise<void>((resolve) => { releaseRename = resolve; });
    let markRenameStarted: (() => void) | undefined;
    const renameStarted = new Promise<void>((resolve) => { markRenameStarted = resolve; });
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      markRenameStarted?.();
      await renameBlocked;
      await realRename(from, to);
    });

    const update = manager.updateConfig({ theme: 'forge' });
    await renameStarted;
    const reload = manager.reloadFromDisk();
    releaseRename?.();
    await Promise.all([update, reload]);

    expect(manager.getConfig().theme).toBe('forge');
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).theme).toBe('forge');
    rename.mockRestore();
  });

  it('rejects a mismatched slot without changing memory or disk', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const before = await fs.readFile(configPath, 'utf8');
    // SAFETY: Deliberately bypasses the compile-time slot type to exercise the runtime persistence boundary.
    await expect(manager.updateConfig({ systemDarkTheme: 'folio' as never })).rejects.toThrow('systemDarkTheme must be a dark palette');
    expect(manager.getConfig().systemDarkTheme).toBe('dark');
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
  });

  it('keeps memory and disk unchanged when the atomic rename fails', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const before = await fs.readFile(configPath, 'utf8');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(manager.updateConfig({ theme: 'forge' })).rejects.toThrow('rename failed');
    expect(manager.getConfig().theme).toBe('light-rounded');
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    rename.mockRestore();
  });
});


describe('ConfigManager freeze prevention defaults', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let paneDir: string;

  beforeEach(async () => {
    paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-freeze-config-'));
    vi.stubEnv('PANE_DIR', paneDir);
    vi.stubEnv('PANE_USE_PTY_HOST', '');
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', originalPlatform);
    vi.unstubAllEnvs();
    await fs.rm(paneDir, { recursive: true, force: true });
  });

  it.each(['win32', 'darwin', 'linux'])('defaults the isolated PTY host appropriately on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    await fs.writeFile(path.join(paneDir, 'config.json'), JSON.stringify({ verbose: false }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getUsePtyHost()).toBe(platform === 'win32');
    expect(manager.getConfig().usePtyHost).toBe(platform === 'win32');
    expect(manager.getGitRepoPath()).toBe('');
  });

  it('preserves an explicit Windows opt-out and honors the development override', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await fs.writeFile(path.join(paneDir, 'config.json'), JSON.stringify({ usePtyHost: false }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getUsePtyHost()).toBe(false);
    vi.stubEnv('PANE_USE_PTY_HOST', '1');
    expect(manager.getUsePtyHost()).toBe(true);
  });

  it('rejects a legacy home-directory Git root but preserves a project path', () => {
    expect(new ConfigManager(os.homedir()).getGitRepoPath()).toBe('');
    const repoPath = path.join(os.homedir(), 'project');
    expect(new ConfigManager(repoPath).getGitRepoPath()).toBe(repoPath);
  });
});

describe('ConfigManager keyboard shortcut overrides', () => {
  let directory = '';
  let previousPaneDir: string | undefined;

  beforeEach(async () => {
    previousPaneDir = process.env.PANE_DIR;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-keybindings-'));
    process.env.PANE_DIR = directory;
  });

  afterEach(async () => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    await fs.rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps absence sparse and deletes an empty reset map', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    await manager.updateConfig({ keyboardShortcutOverrides: { 'open-settings': 'mod+alt+7' } });
    await manager.updateConfig({ keyboardShortcutOverrides: {} });
    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')))
      .not.toHaveProperty('keyboardShortcutOverrides');

    await manager.updateConfig({ keyboardShortcutOverrides: { 'open-settings': 'mod+alt+7' } });
    const persisted = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    delete persisted.keyboardShortcutOverrides;
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(persisted));
    await manager.reloadFromDisk();
    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
  });

  it('round-trips null, unknown ids, and invalid chords verbatim', async () => {
    const raw = {
      'open-settings': null,
      'future-command': 'mod+alt+8',
      'new-session': 'not-a-chord',
    };
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ keyboardShortcutOverrides: raw }));
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.updateConfig({ verbose: true });
    expect(manager.getConfig().keyboardShortcutOverrides).toEqual(raw);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).keyboardShortcutOverrides)
      .toEqual(raw);
  });

  it('preserves a map whose entries are all unknown or invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = { 'future-command': 'mod+alt+8', 'new-session': 'not-a-chord' };
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ keyboardShortcutOverrides: raw }));
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.updateConfig({ verbose: true });
    expect(manager.getConfig().keyboardShortcutOverrides).toEqual(raw);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).keyboardShortcutOverrides)
      .toEqual(raw);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown keyboard shortcut id: future-command'));
    warn.mockRestore();
  });

  it('drops and diagnoses a non-object override map loaded from disk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
      keyboardShortcutOverrides: 'abc',
    }));
    const manager = new ConfigManager();
    await manager.initialize();

    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('must be an object'));
  });

  it('drops and diagnoses a non-object override map received in an update', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new ConfigManager();
    await manager.initialize();

    const malformedUpdate = JSON.parse('{"keyboardShortcutOverrides":["mod+x"]}');
    await manager.updateConfig(malformedUpdate);

    expect(manager.getConfig()).not.toHaveProperty('keyboardShortcutOverrides');
    expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')))
      .not.toHaveProperty('keyboardShortcutOverrides');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('must be an object'));
  });

  it('logs a snippet/agent conflict with both owners once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
      terminalShortcuts: [{ id: 'duplicate', label: 'Duplicate', key: '3', text: '', enabled: true }],
    }));
    const manager = new ConfigManager();
    await manager.initialize();
    await manager.reloadFromDisk();
    const messages = warn.mock.calls.map(call => call.join(' ')).filter(message => message.includes('conflict'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('add-tool-terminal-claude');
    expect(messages[0]).toContain('terminal-shortcut-duplicate');
  });
});
