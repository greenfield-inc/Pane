import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trustClaudeSessionFolder } from './claudeFolderTrust';

describe('trustClaudeSessionFolder', () => {
  const previousPaneDir = process.env.PANE_DIR;
  const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  let root: string;
  let configPath: string;
  let sessionFolder: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-claude-trust-')));
    process.env.PANE_DIR = path.join(root, 'pane');
    sessionFolder = path.join(root, 'pane', 'sessions', 'legacy-pane-chat');
    fs.mkdirSync(sessionFolder, { recursive: true });
    configPath = path.join(root, '.claude.json');
    // Claude looks for backups under CLAUDE_CONFIG_DIR; keep it in the fixture.
    process.env.CLAUDE_CONFIG_DIR = root;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PANE_DIR = previousPaneDir;
    if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('sets only the trust flag for the Session folder and keeps every other key', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      numStartups: 7,
      oauthAccount: { emailAddress: 'a@example.com' },
      projects: {
        '/work/repo': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] },
        [sessionFolder]: { allowedTools: [], lastCost: 1.5 },
      },
    }), { mode: 0o600 });

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(readConfig()).toEqual({
      numStartups: 7,
      oauthAccount: { emailAddress: 'a@example.com' },
      projects: {
        '/work/repo': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] },
        [sessionFolder]: { allowedTools: [], lastCost: 1.5, hasTrustDialogAccepted: true },
      },
    });
    // Windows has no POSIX permission bits to keep.
    if (process.platform !== 'win32') expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('creates the project entry when the config has none', async () => {
    fs.writeFileSync(configPath, '{"theme":"dark"}');

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(readConfig()).toEqual({ theme: 'dark', projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
  });

  it('leaves an already trusted folder file untouched', async () => {
    const original = JSON.stringify({ projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
    fs.writeFileSync(configPath, original);

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('creates a missing config with only the trust entry', async () => {
    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(readConfig()).toEqual({ projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
    if (process.platform !== 'win32') expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
  });

  it('leaves a missing config missing when Claude has a backup to restore from', async () => {
    fs.mkdirSync(path.join(root, 'backups'));
    fs.writeFileSync(path.join(root, 'backups', '.claude.json.backup.1760000000000'), '{}');

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('skips an invalid config', async () => {
    fs.writeFileSync(configPath, '{"projects": {');
    await trustClaudeSessionFolder(sessionFolder, configPath);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"projects": {');
  });

  it('keeps a change another writer makes while Pane is writing', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'old', projects: { '/other': { hasTrustDialogAccepted: true } } }));
    const readFile = fs.promises.readFile.bind(fs.promises);
    let injected = false;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof readFile>) => {
      const text = await readFile(...args);
      if (!injected) {
        injected = true;
        fs.writeFileSync(configPath, JSON.stringify({ theme: 'new', projects: { '/other': { hasTrustDialogAccepted: false } } }));
      }
      return text;
    });

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(readConfig()).toEqual({
      theme: 'new',
      projects: { '/other': { hasTrustDialogAccepted: false }, [sessionFolder]: { hasTrustDialogAccepted: true } },
    });
  });

  it('waits for Claude\'s config lock and writes after it is released', async () => {
    fs.writeFileSync(configPath, '{}');
    fs.mkdirSync(`${configPath}.lock`);
    setTimeout(() => fs.rmdirSync(`${configPath}.lock`), 120);

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(readConfig()).toEqual({ projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
  });

  it('skips the write while Claude holds its config lock', async () => {
    fs.writeFileSync(configPath, '{}');
    fs.mkdirSync(`${configPath}.lock`);

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
    expect(fs.existsSync(`${configPath}.lock`)).toBe(true);
  });

  it('takes over a lock older than Claude\'s 10 second stale limit', async () => {
    fs.writeFileSync(configPath, '{}');
    fs.mkdirSync(`${configPath}.lock`);
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(`${configPath}.lock`, old, old);

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(readConfig()).toEqual({ projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
    expect(fs.existsSync(`${configPath}.lock`)).toBe(false);
  });

  it('ignores folders outside this Pane\'s sessions directory', async () => {
    fs.writeFileSync(configPath, '{}');
    const repo = path.join(root, 'repo');
    const nested = path.join(sessionFolder, 'nested');
    fs.mkdirSync(repo);
    fs.mkdirSync(nested);

    await trustClaudeSessionFolder(repo, configPath);
    await trustClaudeSessionFolder(nested, configPath);

    expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
  });

  it('writes through a symlinked config instead of replacing the link', async () => {
    const real = path.join(root, 'dotfiles-claude.json');
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, configPath);

    await trustClaudeSessionFolder(sessionFolder, configPath);

    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
  });
});
