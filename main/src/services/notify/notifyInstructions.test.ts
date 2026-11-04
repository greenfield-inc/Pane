import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncNotifyInstructions, syncWslNotifyInstructions } from './notifyInstructions';

const BEGIN = '<!-- pane-notify:begin (managed by Pane; edits are replaced) -->';
const END = '<!-- pane-notify:end -->';
/** The block Pane 2.4.207 and earlier wrote, which told agents to give up without the MCP tool. */
const V1_BLOCK = [
  BEGIN,
  '## Pane Notify',
  "When you need the person (a choice, an approval, a short answer), call the `pane` MCP's `notify` instead of asking in the terminal. If the tool isn't available, ignore this.",
  "- Ask only what you can't find out yourself.",
  '- `waiting` means call `notify` again with `resume`; `unavailable` means ask in the terminal.',
  END,
].join('\n');

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

  const sync = (enabled: boolean, homeSkill = true) =>
    syncNotifyInstructions(enabled, { homeSkill }, { CODEX_HOME: path.join(home, 'codex-home') }, home);
  const text = (file: string) => fs.readFileSync(file, 'utf8');

  it('adds the block after the person\'s own text and keeps every byte of it', () => {
    const own = '﻿# Mine\r\nUse pnpm.\r\n';
    fs.writeFileSync(claudeFile, own);

    expect(sync(true).map(file => file.state)).toEqual(['written', 'written']);

    const written = text(claudeFile);
    expect(written.startsWith(`${own}${BEGIN}\r\n## Pane\r\n`)).toBe(true);
    expect(written).toContain('\r\n## Pane Notify\r\n');
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

  it('opens with a Pane section that reads sensibly outside Pane and names the skill and runpane', () => {
    sync(true);
    const lines = text(claudeFile).split('\n');

    expect(lines.slice(0, 5)).toEqual([
      BEGIN,
      '## Pane',
      'When PANE_SESSION_ID is set, you are in a Pane terminal: load the `pane` skill before using Pane (worktrees, Panes, Sessions, asking the person).',
      expect.stringContaining('run `$PANE_RUNPANE_BIN` (Pane terminals set it'),
      '',
    ]);
    expect(lines[5]).toBe('## Pane Notify');
    // Without the MCP tool, agents fall back to the CLI instead of giving up.
    expect(lines[6]).toContain("If that tool isn't loaded, run `runpane notify --ui options|approve|ask|info --title <text>`");
    expect(text(claudeFile)).not.toContain('ignore this');
  });

  it.each([
    ['macOS and Linux', 'darwin' as const, '/Users/ana', '`/Users/ana/.pane/bin/runpane`'],
    // One spelling PowerShell, cmd and Git Bash all run.
    ['Windows', 'win32' as const, 'C:\\Users\\Ana Ruiz', '`C:/Users/Ana Ruiz/.pane/bin/runpane.cmd`'],
  ])('points %s agents at the installed runpane shim', (_name, platform, userHome, shim) => {
    const dir = path.join(home, 'agent');
    fs.mkdirSync(dir);
    syncNotifyInstructions(true, { homeSkill: true }, { CLAUDE_CONFIG_DIR: dir, CODEX_HOME: path.join(home, 'none') }, userHome, platform);

    const fallback = text(path.join(dir, 'CLAUDE.md')).split('\n')[3];
    expect(fallback).toContain(shim);
    expect(fallback.includes('& $env:PANE_RUNPANE_BIN')).toBe(platform === 'win32');
  });

  it('drops the pointer to the `pane` skill while the skill is turned off, and keeps the runpane fallback', () => {
    sync(true, false);
    const written = text(claudeFile);

    expect(written).not.toContain('`pane` skill');
    expect(written).toContain('`runpane agent-context --json` lists what you can do with Pane');
    expect(written).toContain('`$PANE_RUNPANE_BIN`');
    expect(written).toContain('run `runpane notify --ui');

    sync(true, true);
    expect(text(claudeFile)).toContain('load the `pane` skill');
  });

  it('upgrades the block an earlier Pane wrote in place, keeping the person\'s text on both sides', () => {
    const before = '# Mine\r\n\r\n';
    const after = '\r\n## Later rules\r\nUse pnpm.\r\n';
    fs.writeFileSync(claudeFile, `${before}${V1_BLOCK.replace(/\n/g, '\r\n')}\r\n${after}`);

    expect(sync(true)[0].state).toBe('written');
    const written = text(claudeFile);
    expect(written.startsWith(`${before}${BEGIN}\r\n## Pane\r\n`)).toBe(true);
    expect(written.endsWith(`${END}\r\n${after}`)).toBe(true);
    expect(written.split(BEGIN)).toHaveLength(2);
    expect(written).not.toContain('ignore this');

    sync(false);
    expect(text(claudeFile)).toBe(`${before}${after}`);
  });

  it('writes the block into each WSL distro\'s own agent folders, with the WSL path to runpane', async () => {
    const claude = path.join(home, 'wsl-claude');
    const codex = path.join(home, 'wsl-codex');
    fs.mkdirSync(claude);
    fs.mkdirSync(codex);
    const resolve = vi.fn(async (distro: string) => {
      if (distro === 'Stopped') throw new Error('wsl.exe timed out');
      return { claude, codex };
    });

    const results = await syncWslNotifyInstructions(true, { homeSkill: true }, ['Ubuntu', 'Stopped'], 'C:\\Users\\ana', resolve);

    expect(results.map(result => result.state)).toEqual(['written', 'written', 'skipped']);
    expect(results[2].reason).toContain('WSL distro Stopped');
    for (const file of [path.join(claude, 'CLAUDE.md'), path.join(codex, 'AGENTS.md')]) {
      expect(text(file)).toContain('or else `/mnt/c/Users/ana/.pane/bin/runpane`.');
    }

    await syncWslNotifyInstructions(false, { homeSkill: true }, ['Ubuntu'], 'C:\\Users\\ana', resolve);
    expect(text(path.join(claude, 'CLAUDE.md'))).toBe('');
  });

  describe('on a filesystem without hard links (a WSL home over \\\\wsl.localhost)', () => {
    const noLinks = () => vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOTSUP: operation not supported on socket, link'), { code: 'ENOTSUP' });
    });

    it('still creates, refreshes and removes the block', () => {
      noLinks();
      expect(sync(true).map(file => file.state)).toEqual(['written', 'written']);
      expect(text(claudeFile).startsWith(BEGIN)).toBe(true);

      fs.writeFileSync(claudeFile, `# Mine\n${V1_BLOCK}\n`);
      sync(true);
      expect(text(claudeFile).startsWith(`# Mine\n${BEGIN}\n## Pane\n`)).toBe(true);

      sync(false);
      expect(text(claudeFile)).toBe('# Mine\n');
    });

    it('starts over from a personal edit made since Pane read the file', () => {
      noLinks();
      fs.writeFileSync(claudeFile, '# My rules\n');
      const write = fs.writeFileSync;
      let interleaved = false;
      vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
        write(...args);
        // Another editor saves just after Pane writes its copy beside the file.
        if (!interleaved && String(args[0]).endsWith('.tmp')) {
          interleaved = true;
          fs.appendFileSync(claudeFile, 'Never deploy without asking me.\n');
        }
      });

      expect(sync(true)[0].state).toBe('written');
      expect(interleaved).toBe(true);
      expect(text(claudeFile).startsWith('# My rules\nNever deploy without asking me.\n')).toBe(true);
      expect(text(claudeFile)).toContain(BEGIN);
    });
  });
});
