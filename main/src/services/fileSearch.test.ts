import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import { existingFiles, FileSearch, leavesFolder } from './fileSearch';

let base: string;
let root: string;
let search: FileSearch;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' });
const write = async (file: string, text = '') => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
};
const find = async (query: string, options: { walk?: boolean; limit?: number; fuzzy?: boolean; fresh?: boolean } = {}) =>
  (await search.search({ storedPath: root, pathResolver: new PathResolver({ path: root }), commandRunner: new CommandRunner({ path: root }), walk: options.walk }, query, options.limit ?? 80, { fuzzy: options.fuzzy, fresh: options.fresh }))
    .map(file => file.isDirectory ? `${file.path}/` : file.path);

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-file-search-'));
  root = path.join(base, 'repo');
  await fs.mkdir(root);
  search = new FileSearch();
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(base, { recursive: true, force: true });
});

describe('a worktree', () => {
  beforeEach(() => { git('init', '-q'); });

  it('lists top-level folders, then files, for an empty query', async () => {
    for (const file of ['src/a.ts', 'docs/b.md', 'README.md', '.gitignore']) await write(file);
    expect(await find('')).toEqual(['docs/', 'src/', '.gitignore', 'README.md']);
  });

  it('ranks the name before the path, and letters in order last, at any depth', async () => {
    for (const file of ['deep/a/b/c/d/e/f/composer.ts', 'composer/index.ts', 'src/ChatComposer.ts', 'src/cxoxmxp.ts']) await write(file);
    expect(await find('composer')).toEqual(['composer/', 'deep/a/b/c/d/e/f/composer.ts', 'src/ChatComposer.ts', 'composer/index.ts']);
    expect(await find('comp')).toContain('src/cxoxmxp.ts');
    expect(await find('src/chat')).toEqual(['src/ChatComposer.ts']);
  });

  it('keeps spaces, apostrophes and other scripts, and leaves out names no reference can hold', async () => {
    for (const file of ['my notes.md', 'it\'s.md', '日本語.md']) await write(file);
    if (process.platform !== 'win32') for (const file of ['a"b.md', 'c\nd.md']) await write(file);
    expect((await find('.md')).sort()).toEqual(['it\'s.md', 'my notes.md', '日本語.md'].sort());
  });

  it('never lists gitignored files, .git, nested worktrees or links that leave the folder', async () => {
    await write('.gitignore', 'secret.txt\nworktrees/\n');
    for (const file of ['secret.txt', 'kept.txt', 'worktrees/nested/inner.txt']) await write(file);
    git('add', '.');
    git('commit', '-qm', 'first');
    git('worktree', 'add', '-q', '-b', 'nested', path.join(root, 'tree'));
    await write('tree/inner.txt');
    await fs.writeFile(path.join(base, 'outside.txt'), '');
    await fs.mkdir(path.join(base, 'elsewhere'));
    await fs.writeFile(path.join(base, 'elsewhere', 'other.txt'), '');
    if (process.platform !== 'win32') {
      await fs.symlink(path.join(base, 'outside.txt'), path.join(root, 'link.txt'));
      await fs.symlink(path.join(base, 'elsewhere'), path.join(root, 'linked'));
      await fs.symlink('kept.txt', path.join(root, 'near.txt'));
    }
    const near = process.platform === 'win32' ? [] : ['near.txt'];
    expect((await find('')).sort()).toEqual(['.gitignore', 'kept.txt', ...near].sort());
    expect((await find('txt')).sort()).toEqual(['kept.txt', ...near].sort());
    for (const query of ['inner', 'other', 'outside', 'secret', 'config', 'HEAD', 'linked/other', 'worktrees/nested/inner.txt']) expect({ query, found: await find(query) }).toEqual({ query, found: [] });
  });

  it('drops a file that is gone, and shows a new one when the menu opens again', async () => {
    await write('one.txt');
    expect(await find('')).toEqual(['one.txt']);
    await fs.rm(path.join(root, 'one.txt'));
    await write('two.txt');
    expect(await find('one')).toEqual([]);
    expect(await find('')).toEqual(['two.txt']);
  });

  it('a search box gets only names that hold the text, listed fresh each time', async () => {
    for (const file of ['src/cart.ts', 'src/cxaxrxt.ts']) await write(file);
    expect(await find('cart', { fuzzy: false, fresh: true })).toEqual(['src/cart.ts']);
    await write('src/cart-new.ts');
    expect(await find('cart', { fuzzy: false, fresh: true })).toEqual(['src/cart.ts', 'src/cart-new.ts']);
  });

  it('answers only the newest of overlapping searches of a folder', async () => {
    for (let index = 0; index < 3000; index += 1) await write(`many/file-${index}.ts`);
    await find('');
    const [older, newer] = await Promise.all([find('file-1'), find('file-29')]);
    expect(older).toEqual([]);
    expect(newer[0]).toBe('many/file-29.ts');
  });

  it('runs no file-watcher hook', async () => {
    if (process.platform === 'win32') return;
    const hook = path.join(base, 'hook.sh');
    await fs.writeFile(hook, `#!/bin/sh\ntouch "${path.join(base, 'ran')}"\n`, { mode: 0o755 });
    git('config', 'core.fsmonitor', hook);
    await write('a.txt');
    expect(await find('')).toEqual(['a.txt']);
    await expect(fs.access(path.join(base, 'ran'))).rejects.toThrow();
  });

  it('frees its list 30 s after the last search', async () => {
    await write('one.txt');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await find('one');
    await write('one-more.txt');
    expect(await find('one')).toEqual(['one.txt']);
    vi.advanceTimersByTime(30_000);
    expect(await find('one')).toEqual(['one.txt', 'one-more.txt']);
  });
});

describe('a folder outside git', () => {
  it('skips hidden names and follows no links', async () => {
    for (const file of ['plans/a.md', 'report.md', '.agent/state.json', 'plans/.hidden']) await write(file);
    if (process.platform !== 'win32') await fs.symlink(base, path.join(root, 'up'));
    expect(await find('', { walk: true })).toEqual(['plans/', 'report.md']);
    expect(await find('state', { walk: true })).toEqual([]);
    expect(await find('hidden', { walk: true })).toEqual([]);
  });

  it('lists a Session folder the same when a repository surrounds it', async () => {
    git('init', '-q');
    for (const file of ['plans/a.md', '.agent/state.json']) await write(file);
    expect(await find('', { walk: true })).toEqual(['plans/']);
  });
});

it.each(['..', '../x', 'a/../../b', '/etc/passwd', '~/x', '~', 'C:\\x', '..\\x'])('refuses a query that leaves the folder: %j', query => expect(leavesFolder(query)).toBe(true));
it.each(['a..b', 'src/a.ts', '@scope/x', '.github'])('takes %j', query => expect(leavesFolder(query)).toBe(false));

it('names only the changed files that exist inside the folder', async () => {
  await write('kept.ts');
  expect(await existingFiles(root, ['kept.ts', 'gone.ts', '../outside.ts', '/etc/hosts'], 80)).toEqual([{ path: 'kept.ts', isDirectory: false }]);
});
