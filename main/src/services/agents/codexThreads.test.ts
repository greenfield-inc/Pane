import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCodexThread } from './codexThreads';

const cleanup: string[] = [];
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const NOW = Date.parse('2026-11-05T12:00:00Z');

function codexHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'pane-codex-home-'));
  cleanup.push(home);
  const cwd = path.join(home, 'project');
  mkdirSync(cwd);
  const write = (id: string, payload: { cwd?: string; originator?: string; source?: string | { subagent: string } }, modified = NOW, day = '2026/11/05') => {
    const directory = path.join(home, 'sessions', day);
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-11-05T12-00-00-${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, originator: 'codex-tui', source: 'vscode', cwd, ...payload } })}\n{"type":"event"}\n`);
    utimesSync(file, modified / 1000, modified / 1000);
  };
  return { home, cwd, write };
}

describe('finding the Codex conversation a terminal is running', () => {
  it('finds the one interactive thread in this folder active since the terminal launched', async () => {
    const { home, cwd, write } = codexHome();
    write('this-one', {});
    write('older', {}, NOW - 60 * 60 * 1000);
    write('elsewhere', { cwd: path.join(home, 'other') });
    write('chat-tab', { originator: 'pane' });
    write('subagent', { source: { subagent: 'review' } });
    await expect(findCodexThread(cwd, NOW - 1000, home)).resolves.toEqual({ id: 'this-one' });
  });

  it('will not guess between two terminals in one folder', async () => {
    const { home, cwd, write } = codexHome();
    write('first', {});
    write('second', {});
    await expect(findCodexThread(cwd, NOW - 1000, home)).resolves.toEqual({ problem: expect.stringContaining('will not guess') });
  });

  it('says so when Codex has saved nothing yet', async () => {
    const { home, cwd } = codexHome();
    await expect(findCodexThread(cwd, NOW - 1000, home)).resolves.toEqual({ problem: expect.stringContaining('no conversation') });
  });
});
