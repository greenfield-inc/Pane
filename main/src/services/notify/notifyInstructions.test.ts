import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncNotifyInstructions } from './notifyInstructions';

const BEGIN = '<!-- pane-notify:begin (managed by Pane; edits are replaced) -->';
const END = '<!-- pane-notify:end -->';

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
  const text = (file: string) => fs.readFileSync(file, 'utf8');

  it('adds the block after the person\'s own text and keeps every byte of it', () => {
    const own = '﻿# Mine\r\nUse pnpm.\r\n';
    fs.writeFileSync(claudeFile, own);

    expect(sync(true).map(file => file.state)).toEqual(['written', 'written']);

    const written = text(claudeFile);
    expect(written.startsWith(`${own}${BEGIN}\r\n## Pane Notify\r\n`)).toBe(true);
    expect(written).toContain("call the `pane` MCP's `notify` instead of asking in the terminal");
    expect(written.endsWith(`${END}\r\n`)).toBe(true);
    // Codex's folder had no AGENTS.md, so Pane created one holding only the block.
    expect(text(codexFile).startsWith(BEGIN)).toBe(true);
  });

  it('changes nothing on a second run', () => {
    fs.writeFileSync(claudeFile, '# Mine\n');
    sync(true);
    const first = fs.readFileSync(claudeFile);
    const firstWrite = fs.statSync(claudeFile).mtimeMs;

    expect(sync(true).map(file => file.state)).toEqual(['written', 'written']);
    expect(fs.readFileSync(claudeFile).equals(first)).toBe(true);
    expect(fs.statSync(claudeFile).mtimeMs).toBe(firstWrite);
  });

  it.each([
    ['an empty file', ''],
    ['text with a final line break', '# Mine\n'],
    ['text without a final line break', '# Mine'],
    ['CRLF text without a final line break', '# Mine\r\nUse pnpm.'],
    ['a lone byte order mark', '﻿'],
    ['a final carriage return', 'Keep final CR\r'],
  ])('gives back %s byte for byte after on, on again and off', (_name, own) => {
    fs.writeFileSync(claudeFile, own);
    sync(true);
    const on = text(claudeFile);
    sync(true);
    expect(text(claudeFile)).toBe(on);

    sync(false);
    // A file Pane didn't create stays, even when it is empty.
    expect(text(claudeFile)).toBe(own);
  });

  it('turning Notify off removes only Pane\'s lines', () => {
    fs.writeFileSync(claudeFile, '# Mine\n\nUse pnpm.\n');
    sync(true);
    // The person writes below the block afterwards, starting with a blank line of their own.
    fs.appendFileSync(claudeFile, '\nAlso: run lint.\n');

    expect(sync(false).map(file => file.state)).toEqual(['absent', 'absent']);
    expect(text(claudeFile)).toBe('# Mine\n\nUse pnpm.\n\nAlso: run lint.\n');
    // The file Pane created stays, empty: Pane never deletes an instruction file.
    expect(text(codexFile)).toBe('');
  });

  it('keeps the person\'s blank lines on both sides of an older block', () => {
    fs.writeFileSync(claudeFile, `# My rules\n\n${BEGIN}\nold block\n${END}\n\nMore rules\n`);

    sync(false);
    expect(text(claudeFile)).toBe('# My rules\n\n\nMore rules\n');
  });

  it('keeps a personal edit made while Pane writes, and adds the block to it', () => {
    fs.writeFileSync(claudeFile, '# My rules\n');
    const rename = fs.renameSync;
    let interleaved = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      // Another editor saves just as Pane swaps its copy in.
      if (to === claudeFile && !interleaved) {
        interleaved = true;
        fs.appendFileSync(claudeFile, 'Never deploy without asking me.\n');
      }
      rename(from, to);
    });

    expect(sync(true)[0].state).toBe('written');
    expect(interleaved).toBe(true);
    expect(text(claudeFile).startsWith('# My rules\nNever deploy without asking me.\n')).toBe(true);
    expect(text(claudeFile)).toContain(BEGIN);
  });

  it('leaves a file alone when Pane\'s markers don\'t pair up', () => {
    const own = `# Mine\n${BEGIN}\nhalf a block\n`;
    fs.writeFileSync(claudeFile, own);

    const [claude] = sync(true);
    expect(claude).toMatchObject({ state: 'skipped', reason: expect.stringContaining("don't pair up") });
    expect(text(claudeFile)).toBe(own);
    sync(false);
    expect(text(claudeFile)).toBe(own);
  });

  it.each([
    ['a symlink', '# Shared\n'],
    ['a dangling symlink', null],
  ])('never writes through %s', (_name, targetText) => {
    const target = path.join(home, 'dotfiles-CLAUDE.md');
    if (targetText !== null) fs.writeFileSync(target, targetText);
    fs.symlinkSync(target, claudeFile, 'file');

    for (const enabled of [true, false]) {
      expect(sync(enabled)[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('symlink') });
      expect(fs.lstatSync(claudeFile).isSymbolicLink()).toBe(true);
    }
    expect(fs.existsSync(target) ? text(target) : null).toBe(targetText);
  });

  it.skipIf(process.platform === 'win32')('skips a FIFO instead of waiting on it', () => {
    execFileSync('mkfifo', [claudeFile]);

    expect(sync(true)[0]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('regular file') });
  });

  it('creates nothing for an agent whose config folder is missing', () => {
    fs.rmSync(path.join(home, 'codex-home'), { recursive: true });

    expect(sync(true)[1]).toMatchObject({ agent: 'Codex', state: 'not-found' });
    expect(fs.existsSync(path.join(home, 'codex-home'))).toBe(false);
  });
});
