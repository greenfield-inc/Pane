import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncNotifyInstructions } from './notifyInstructions';

describe('Pane Notify instructions in the agents\' user-level files', () => {
  let home: string;
  let claudeFile: string;
  let codexFile: string;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-notify-instructions-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, 'codex-home'));
    claudeFile = path.join(home, '.claude', 'CLAUDE.md');
    codexFile = path.join(home, 'codex-home', 'AGENTS.md');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const sync = (enabled: boolean) => syncNotifyInstructions(enabled, { CODEX_HOME: path.join(home, 'codex-home') }, home);
  const read = (file: string) => fs.readFileSync(file);

  it('adds the block after the person\'s own text and keeps every byte of it', () => {
    const own = Buffer.from('﻿# Mine\r\nUse pnpm.\r\n', 'utf8');
    fs.writeFileSync(claudeFile, own);

    expect(sync(true).map(file => file.state)).toEqual(['written', 'written']);

    const written = read(claudeFile).toString('utf8');
    expect(written.startsWith(own.toString('utf8'))).toBe(true);
    expect(written).toContain('<!-- pane-notify:begin (managed by Pane; edits are replaced) -->\r\n## Pane Notify\r\n');
    expect(written).toContain("call the `pane` MCP's `notify` instead of asking in the terminal");
    expect(written.endsWith('<!-- pane-notify:end -->\r\n')).toBe(true);
    // Codex's folder had no AGENTS.md, so Pane created one holding only the block.
    expect(read(codexFile).toString('utf8').startsWith('<!-- pane-notify:begin')).toBe(true);
  });

  it('changes nothing on a second run', () => {
    fs.writeFileSync(claudeFile, '# Mine\n');
    sync(true);
    const first = read(claudeFile);
    const firstWrite = fs.statSync(claudeFile).mtimeMs;

    expect(sync(true).map(file => file.state)).toEqual(['written', 'written']);
    expect(read(claudeFile).equals(first)).toBe(true);
    expect(fs.statSync(claudeFile).mtimeMs).toBe(firstWrite);
  });

  it('turning Notify off removes only Pane\'s lines', () => {
    fs.writeFileSync(claudeFile, '# Mine\n\nUse pnpm.\n');
    sync(true);
    // The person writes below the block afterwards.
    fs.appendFileSync(claudeFile, '\nAlso: run lint.\n');

    expect(sync(false).map(file => file.state)).toEqual(['absent', 'absent']);
    expect(read(claudeFile).toString('utf8')).toBe('# Mine\n\nUse pnpm.\n\nAlso: run lint.\n');
    // The file Pane created held nothing else, so it is gone again.
    expect(fs.existsSync(codexFile)).toBe(false);
  });

  it('leaves a file alone when Pane\'s markers don\'t pair up', () => {
    const own = '# Mine\n<!-- pane-notify:begin (managed by Pane; edits are replaced) -->\nhalf a block\n';
    fs.writeFileSync(claudeFile, own);

    const [claude] = sync(true);
    expect(claude).toMatchObject({ state: 'skipped', reason: expect.stringContaining("don't pair up") });
    expect(read(claudeFile).toString('utf8')).toBe(own);
    sync(false);
    expect(read(claudeFile).toString('utf8')).toBe(own);
  });

  // Windows needs extra rights to create a symlink.
  it.skipIf(process.platform === 'win32')('never writes through a symlink', () => {
    const target = path.join(home, 'dotfiles-CLAUDE.md');
    fs.writeFileSync(target, '# Shared\n');
    fs.symlinkSync(target, claudeFile);

    const [claude] = sync(true);
    expect(claude).toMatchObject({ state: 'skipped', reason: expect.stringContaining('symlink') });
    expect(fs.readFileSync(target, 'utf8')).toBe('# Shared\n');
    expect(fs.lstatSync(claudeFile).isSymbolicLink()).toBe(true);
  });

  it('creates nothing for an agent whose config folder is missing', () => {
    fs.rmSync(path.join(home, 'codex-home'), { recursive: true });

    expect(sync(true)[1]).toMatchObject({ agent: 'Codex', state: 'not-found' });
    expect(fs.existsSync(path.join(home, 'codex-home'))).toBe(false);
  });
});
