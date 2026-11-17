import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bringBackIgnoredFiles, keepIgnoredFiles } from './ignoredFiles';

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir } }).toString().trim();

beforeEach(() => {
  // Real path: git reports the repository under /private on macOS.
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-move-ignored-')));
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

it('keeps a file in staging, never deletes it, when it can\'t go back into the worktree either (F-2)', async () => {
  const wt = path.join(dir, 'wt');
  const kept = path.join(dir, 'repo/.git/pane-moved/pane-1');
  const staging = `${kept}.incoming`;
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(wt, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'x');
  // node_modules can't be set aside, and then the worktree turns unwritable, so .env can't go back.
  const rename = fs.promises.rename;
  const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).includes('node_modules') || String(from).startsWith(staging)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return rename(from, to);
  });
  const cpSpy = vi.spyOn(fs.promises, 'cp').mockRejectedValue(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }));
  try {
    const failure = keepIgnoredFiles(wt, 'pane-1', ['.env', 'node_modules/']);
    await expect(failure).rejects.toMatchObject({ code: 'ERR_MOVE_IGNORED_STRANDED' });
    await expect(failure).rejects.toThrow(staging);
  } finally {
    renameSpy.mockRestore();
    cpSpy.mockRestore();
  }
  expect(fs.readFileSync(path.join(staging, '.env'), 'utf8')).toBe('SECRET=1\n');
  // A later retire refuses rather than clearing the folder that holds the only copy.
  await expect(keepIgnoredFiles(wt, 'pane-1', ['node_modules/'])).rejects.toMatchObject({ code: 'ERR_MOVE_IGNORED_STAGED' });
  expect(fs.readFileSync(path.join(staging, '.env'), 'utf8')).toBe('SECRET=1\n');
  expect(fs.existsSync(path.join(wt, 'node_modules/pkg/index.js'))).toBe(true);
});

it('keeps the earlier kept copy until the new one is in place (F-2)', async () => {
  const wt = path.join(dir, 'wt');
  const kept = path.join(dir, 'repo/.git/pane-moved/pane-1');
  const staging = `${kept}.incoming`;
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, 'earlier'), 'from the last move');
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  const rename = fs.promises.rename;
  const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from) === staging) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return rename(from, to);
  });
  try {
    await expect(keepIgnoredFiles(wt, 'pane-1', ['.env'])).rejects.toMatchObject({ code: 'ERR_MOVE_IGNORED_STRANDED' });
  } finally {
    renameSpy.mockRestore();
  }
  expect(fs.readFileSync(path.join(kept, 'earlier'), 'utf8')).toBe('from the last move');
  expect(fs.readFileSync(path.join(staging, '.env'), 'utf8')).toBe('SECRET=1\n');
  expect(fs.existsSync(`${kept}.previous`)).toBe(false);
});

it('replaces an earlier kept copy on success and leaves no staging behind', async () => {
  const wt = path.join(dir, 'wt');
  const kept = path.join(dir, 'repo/.git/pane-moved/pane-1');
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, 'earlier'), 'from the last move');
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=2\n');
  expect(await keepIgnoredFiles(wt, 'pane-1', ['.env'])).toEqual(['.env']);
  expect(fs.readFileSync(path.join(kept, '.env'), 'utf8')).toBe('SECRET=2\n');
  expect(fs.existsSync(path.join(kept, 'earlier'))).toBe(false);
  expect(fs.existsSync(`${kept}.incoming`)).toBe(false);
  expect(fs.existsSync(`${kept}.previous`)).toBe(false);
});

it.skipIf(process.platform === 'win32')('keeps the whole copy in staging when the source is only partly removed after a copy across volumes (F-2)', async () => {
  const wt = path.join(dir, 'wt');
  const kept = path.join(dir, 'repo/.git/pane-moved/pane-1');
  const staging = `${kept}.incoming`;
  // A directory whose removal deletes `a-first.txt`, then fails on the read-only `locked/`.
  fs.mkdirSync(path.join(wt, 'node_modules/locked'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules/a-first.txt'), 'only copy after a partial removal');
  fs.writeFileSync(path.join(wt, 'node_modules/locked/inner.txt'), 'stays');
  fs.chmodSync(path.join(wt, 'node_modules/locked'), 0o555);
  // Only the cross-volume rename is faked; the copy and the removal are real.
  const rename = fs.promises.rename;
  const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).startsWith(wt) || String(from).startsWith(staging)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    return rename(from, to);
  });
  try {
    const failure = keepIgnoredFiles(wt, 'pane-1', ['node_modules/']);
    await expect(failure).rejects.toMatchObject({ code: 'ERR_MOVE_IGNORED_STRANDED' });
    await expect(failure).rejects.toThrow(staging);
  } finally {
    renameSpy.mockRestore();
  }
  // Every byte survives somewhere: the staged copy is whole, and the worktree's remainder is untouched.
  expect(fs.readFileSync(path.join(staging, 'node_modules/a-first.txt'), 'utf8')).toBe('only copy after a partial removal');
  expect(fs.readFileSync(path.join(staging, 'node_modules/locked/inner.txt'), 'utf8')).toBe('stays');
  expect(fs.readFileSync(path.join(wt, 'node_modules/locked/inner.txt'), 'utf8')).toBe('stays');
  // A later retire refuses rather than clearing that folder.
  await expect(keepIgnoredFiles(wt, 'pane-1', ['node_modules/'])).rejects.toMatchObject({ code: 'ERR_MOVE_IGNORED_STAGED' });
  expect(fs.existsSync(path.join(staging, 'node_modules/a-first.txt'))).toBe(true);
  for (const locked of [path.join(wt, 'node_modules/locked'), path.join(staging, 'node_modules/locked')]) if (fs.existsSync(locked)) fs.chmodSync(locked, 0o755);
});

it('removes the source only after a copy across volumes matches it', async () => {
  const wt = path.join(dir, 'wt');
  const kept = path.join(dir, 'repo/.git/pane-moved/pane-1');
  fs.mkdirSync(path.join(wt, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'x');
  fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
  const rename = fs.promises.rename;
  const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(from).startsWith(wt)) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    return rename(from, to);
  });
  // A copy that silently drops a file is caught by the check, and the source stays.
  const cp = fs.promises.cp;
  const cpSpy = vi.spyOn(fs.promises, 'cp').mockImplementation(async (from, to, options) => {
    await cp(from, to, options);
    if (String(from).endsWith('node_modules')) fs.rmSync(path.join(String(to), 'pkg/index.js'));
  });
  try {
    await expect(keepIgnoredFiles(wt, 'pane-1', ['.env', 'node_modules/'])).rejects.toThrow(/didn't match/);
  } finally {
    renameSpy.mockRestore();
    cpSpy.mockRestore();
  }
  expect(fs.readFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'utf8')).toBe('x');
  expect(fs.readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
  expect(fs.existsSync(`${kept}.incoming`)).toBe(false);
});
