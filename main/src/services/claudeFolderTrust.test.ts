import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trustClaudeSessionFolder } from './claudeFolderTrust';

describe('trustClaudeSessionFolder', () => {
  const previousPaneDir = process.env.PANE_DIR;
  let root: string;
  let configPath: string;
  let sessionFolder: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-claude-trust-')));
    process.env.PANE_DIR = path.join(root, 'pane');
    sessionFolder = path.join(root, 'pane', 'sessions', 'legacy-pane-chat');
    fs.mkdirSync(sessionFolder, { recursive: true });
    configPath = path.join(root, '.claude.json');
  });

  afterEach(() => {
    process.env.PANE_DIR = previousPaneDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('sets only the trust flag for the Session folder and keeps every other key', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      numStartups: 7,
      oauthAccount: { emailAddress: 'a@example.com' },
      projects: {
        '/work/repo': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] },
        [sessionFolder]: { allowedTools: [], lastCost: 1.5 },
      },
    }), { mode: 0o600 });

    trustClaudeSessionFolder(sessionFolder, configPath);

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

  it('creates the project entry when the config has none', () => {
    fs.writeFileSync(configPath, '{"theme":"dark"}');

    trustClaudeSessionFolder(sessionFolder, configPath);

    expect(readConfig()).toEqual({ theme: 'dark', projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
  });

  it('leaves an already trusted folder file untouched', () => {
    const original = `{"projects":{"${sessionFolder}":{"hasTrustDialogAccepted":true}}}`;
    fs.writeFileSync(configPath, original);

    trustClaudeSessionFolder(sessionFolder, configPath);

    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('skips a missing or invalid config', () => {
    trustClaudeSessionFolder(sessionFolder, configPath);
    expect(fs.existsSync(configPath)).toBe(false);

    fs.writeFileSync(configPath, '{"projects": {');
    trustClaudeSessionFolder(sessionFolder, configPath);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"projects": {');
  });

  it('ignores folders outside this Pane\'s sessions directory', () => {
    fs.writeFileSync(configPath, '{}');
    const repo = path.join(root, 'repo');
    const nested = path.join(sessionFolder, 'nested');
    fs.mkdirSync(repo);
    fs.mkdirSync(nested);

    trustClaudeSessionFolder(repo, configPath);
    trustClaudeSessionFolder(nested, configPath);

    expect(fs.readFileSync(configPath, 'utf8')).toBe('{}');
  });

  it('writes through a symlinked config instead of replacing the link', () => {
    const real = path.join(root, 'dotfiles-claude.json');
    fs.writeFileSync(real, '{}');
    fs.symlinkSync(real, configPath);

    trustClaudeSessionFolder(sessionFolder, configPath);

    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ projects: { [sessionFolder]: { hasTrustDialogAccepted: true } } });
  });
});
