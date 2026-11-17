import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bringBackIgnoredFiles, keepIgnoredFiles } from './ignoredFiles';

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir } }).toString().trim();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-move-ignored-'));
  git(dir, 'init', '-q', 'repo');
  const repo = path.join(dir, 'repo');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules/\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix', path.join(dir, 'wt'));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it('keeps a retired worktree\'s ignored files in the repository and puts them back on restore', async () => {
  const wt = path.join(dir, 'wt');
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(wt, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'x');
  expect(await keepIgnoredFiles(wt, 'pane-1', ['.env', 'node_modules/'])).toEqual(['.env', 'node_modules']);
  expect(fs.existsSync(path.join(wt, '.env'))).toBe(false);
  // Archive removes the worktree; Restore recreates it.
  git(path.join(dir, 'repo'), 'worktree', 'remove', '--force', wt);
  git(path.join(dir, 'repo'), 'worktree', 'add', '-q', wt, 'fix');
  await bringBackIgnoredFiles(wt, 'pane-1');
  expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
  expect(fs.readFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'utf8')).toBe('x');
  expect(fs.existsSync(path.join(dir, 'repo/.git/pane-moved/pane-1'))).toBe(false);
});

it('keeps everything in place when an entry can\'t be set aside, and keeps an earlier kept copy (F-2)', async () => {
  const wt = path.join(dir, 'wt');
  const kept = path.join(dir, 'repo/.git/pane-moved/pane-1');
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, 'earlier'), 'from the last move');
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(wt, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'x');
  // The second entry fails both ways (rename and copy), as a full or read-only disk would.
  const rename = fs.promises.rename;
  const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('node_modules')) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    return rename(from, to);
  });
  const cpSpy = vi.spyOn(fs.promises, 'cp').mockRejectedValue(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
  try {
    await expect(keepIgnoredFiles(wt, 'pane-1', ['.env', 'node_modules/'])).rejects.toThrow(/ENOSPC/);
  } finally {
    renameSpy.mockRestore();
    cpSpy.mockRestore();
  }
  expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
  expect(fs.readFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'utf8')).toBe('x');
  expect(fs.readFileSync(path.join(kept, 'earlier'), 'utf8')).toBe('from the last move');
  expect(fs.existsSync(`${kept}.incoming`)).toBe(false);
});
