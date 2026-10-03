import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatWindowsPathOnPosixHostError } from '../../../shared/types/hostPaths';
import {
  assertPathOnHost,
  browseHostDirectories,
  createHostDirectory,
  HostPathError,
  resolveCloneDestination,
  validateHostProjectPath,
} from './hostPaths';

let home: string;
// Filesystem checks run against this machine; Windows-path checks fake a Linux host and throw before touching disk.
const thisHost = () => ({ platform: process.platform, homeDir: home, hostLabel: 'sandbox-1' });
const linuxHost = () => ({ platform: 'linux' as const, homeDir: home, hostLabel: 'sandbox-1' });

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pane-host-paths-'));
  await mkdir(path.join(home, 'repo', '.git'), { recursive: true });
  await mkdir(path.join(home, 'Notes'));
  await mkdir(path.join(home, '.config'));
  await writeFile(path.join(home, 'file.txt'), 'not a folder');
});

afterEach(async () => {
  await chmod(home, 0o700).catch(() => {});
  await rm(home, { recursive: true, force: true });
});

async function expectHostPathError<Result>(promise: Promise<Result>, code: string, message?: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(HostPathError);
  await expect(promise).rejects.toMatchObject(message === undefined ? { code } : { code, message });
}

describe('browseHostDirectories', () => {
  it('opens at the host home and lists subfolders with git and hidden flags', async () => {
    const result = await browseHostDirectories({}, thisHost());

    expect(result.path).toBe(home);
    expect(result.home).toBe(home);
    expect(result.parent).toBe(path.dirname(home));
    expect(result.platform).toBe(process.platform);
    expect(result.entries).toEqual([
      { name: '.config', path: path.join(home, '.config'), isGitRepo: false, isHidden: true },
      { name: 'Notes', path: path.join(home, 'Notes'), isGitRepo: false, isHidden: false },
      { name: 'repo', path: path.join(home, 'repo'), isGitRepo: true, isHidden: false },
    ]);
  });

  it('expands ~ paths on the host, hides dot folders on request and can go up', async () => {
    await expect(browseHostDirectories({ path: '~' }, thisHost())).resolves.toMatchObject({ path: home });

    const visible = await browseHostDirectories({ path: '~/', showHidden: false }, thisHost());
    expect(visible.entries.map(entry => entry.name)).toEqual(['Notes', 'repo']);

    const repo = await browseHostDirectories({ path: '~/repo' }, thisHost());
    expect(repo.path).toBe(path.join(home, 'repo'));
    expect(repo.parent).toBe(home);
    expect(repo.entries).toEqual([
      { name: '.git', path: path.join(home, 'repo', '.git'), isGitRepo: false, isHidden: true },
    ]);

    const up = await browseHostDirectories({ path: repo.parent ?? '' }, thisHost());
    expect(up.path).toBe(home);
  });

  it('reports a null parent at the filesystem root', async () => {
    const result = await browseHostDirectories({ path: '/' }, thisHost());
    expect(result.parent).toBeNull();
  });

  it('returns structured errors for missing paths, files and unreadable folders', async () => {
    await expectHostPathError(browseHostDirectories({ path: '~/missing' }, thisHost()), 'NOT_FOUND');
    await expectHostPathError(browseHostDirectories({ path: '~/file.txt' }, thisHost()), 'NOT_A_DIRECTORY');

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      await chmod(path.join(home, 'Notes'), 0o000);
      await expectHostPathError(
        browseHostDirectories({ path: '~/Notes' }, thisHost()),
        'PERMISSION_DENIED',
        `Permission denied: ${path.join(home, 'Notes')}`,
      );
      await chmod(path.join(home, 'Notes'), 0o700);
    }
  });

  it('rejects a Windows path on a POSIX host with the host name', async () => {
    await expectHostPathError(
      browseHostDirectories({ path: 'C:\\Users\\me' }, linuxHost()),
      'WINDOWS_PATH_ON_POSIX_HOST',
      "That's a path on this computer; sandbox-1 is a Linux host. Pick a folder on sandbox-1.",
    );
  });
});

describe('assertPathOnHost', () => {
  it.each([
    'C:\\Users\\me\\my-repo',
    'C:/Users/me/repo',
    'D:',
    '\\\\wsl$\\Ubuntu\\home\\user',
    'repos\\my-repo',
  ])('rejects %s on a Linux host', input => {
    expect(() => assertPathOnHost(input, linuxHost())).toThrow(
      new HostPathError(
        'WINDOWS_PATH_ON_POSIX_HOST',
        "That's a path on this computer; sandbox-1 is a Linux host. Pick a folder on sandbox-1.",
      ),
    );
  });

  it('names macOS hosts and falls back to the machine name without a label', () => {
    expect(() => assertPathOnHost('C:\\x', { platform: 'darwin', hostLabel: 'mini' })).toThrow(
      "That's a path on this computer; mini is a macOS host. Pick a folder on mini.",
    );
    expect(() => assertPathOnHost('C:\\x', { platform: 'linux' })).toThrow(
      formatWindowsPathOnPosixHostError(os.hostname()),
    );
  });

  it('allows POSIX paths on POSIX hosts and Windows paths on Windows hosts', () => {
    expect(() => assertPathOnHost('/home/user/repo', linuxHost())).not.toThrow();
    expect(() => assertPathOnHost('~/repo', linuxHost())).not.toThrow();
    expect(() => assertPathOnHost('C:\\Users\\me\\repo', { platform: 'win32' })).not.toThrow();
    expect(() => assertPathOnHost('\\\\wsl$\\Ubuntu\\home\\user', { platform: 'win32' })).not.toThrow();
  });
});

describe('createHostDirectory', () => {
  it('creates one new folder under the parent', async () => {
    const result = await createHostDirectory({ parent: '~', name: 'my-repo' }, thisHost());

    expect(result).toEqual({ path: path.join(home, 'my-repo') });
    expect(existsSync(path.join(home, 'my-repo'))).toBe(true);
  });

  it.each(['', ' ', '.', '..', 'a/b', 'a\\b'])('rejects the folder name %j', async name => {
    await expectHostPathError(createHostDirectory({ parent: home, name }, thisHost()), 'INVALID_NAME');
  });

  it('reports existing folders, missing parents and Windows parents', async () => {
    await expectHostPathError(createHostDirectory({ parent: home, name: 'Notes' }, thisHost()), 'ALREADY_EXISTS');
    await expectHostPathError(createHostDirectory({ parent: '~/missing', name: 'x' }, thisHost()), 'NOT_FOUND');
    await expectHostPathError(createHostDirectory({ parent: 'C:\\x', name: 'x' }, linuxHost()), 'WINDOWS_PATH_ON_POSIX_HOST');
  });
});

describe('validateHostProjectPath', () => {
  it('accepts an existing repo for open', async () => {
    await expect(validateHostProjectPath({ path: '~/repo', mode: 'open' }, thisHost(), async registration => registration.path))
      .resolves.toEqual({ path: path.join(home, 'repo'), isGitRepo: true });
  });

  it('rejects open on a folder inside a repo and names the repo root', async () => {
    await mkdir(path.join(home, 'repo', 'src'));
    const repoRoot = path.join(home, 'repo');

    await expectHostPathError(
      validateHostProjectPath({ path: '~/repo/src', mode: 'open' }, thisHost(), async () => repoRoot),
      'NOT_A_GIT_REPO',
      `${path.join(repoRoot, 'src')} is inside the git repository at ${repoRoot}. Open ${repoRoot} instead.`,
    );
  });

  it('rejects open on a missing path, a file or a non-repo, without creating anything', async () => {
    const before = await readdir(home);
    const isRepo = async () => null;

    await expectHostPathError(validateHostProjectPath({ path: '~/missing', mode: 'open' }, thisHost(), isRepo), 'NOT_FOUND');
    await expectHostPathError(validateHostProjectPath({ path: '~/file.txt', mode: 'open' }, thisHost(), isRepo), 'NOT_A_DIRECTORY');
    await expectHostPathError(validateHostProjectPath({ path: '~/Notes', mode: 'open' }, thisHost(), isRepo), 'NOT_A_GIT_REPO');

    expect(await readdir(home)).toEqual(before);
    expect(existsSync(path.join(home, 'Notes', '.git'))).toBe(false);
  });

  it('accepts a missing or existing folder for new, but not a file', async () => {
    const isRepo = async () => null;
    await expect(validateHostProjectPath({ path: '~/fresh', mode: 'new' }, thisHost(), isRepo))
      .resolves.toEqual({ path: path.join(home, 'fresh'), isGitRepo: false });
    await expect(validateHostProjectPath({ path: '~/Notes', mode: 'new' }, thisHost(), isRepo))
      .resolves.toEqual({ path: path.join(home, 'Notes'), isGitRepo: false });
    await expectHostPathError(validateHostProjectPath({ path: '~/file.txt', mode: 'new' }, thisHost(), isRepo), 'NOT_A_DIRECTORY');
    expect(existsSync(path.join(home, 'fresh'))).toBe(false);
  });

  it('rejects Windows paths in both modes on a POSIX host', async () => {
    for (const mode of ['open', 'new'] as const) {
      await expectHostPathError(
        validateHostProjectPath({ path: 'C:\\Users\\me\\my-repo', mode }, linuxHost(), async registration => registration.path),
        'WINDOWS_PATH_ON_POSIX_HOST',
      );
    }
  });
});

describe('resolveCloneDestination', () => {
  it('defaults to the host home', () => {
    expect(resolveCloneDestination(undefined, thisHost())).toBe(home);
    expect(resolveCloneDestination('', thisHost())).toBe(home);
    expect(resolveCloneDestination('~', thisHost())).toBe(home);
  });

  it('expands ~ on the host and keeps absolute host paths', () => {
    expect(resolveCloneDestination('~/src', thisHost())).toBe(path.join(home, 'src'));
    expect(resolveCloneDestination(path.resolve('/srv/repos'), thisHost())).toBe(path.resolve('/srv/repos'));
  });

  it('rejects a Windows destination on a POSIX host', () => {
    expect(() => resolveCloneDestination('C:\\Users\\me', linuxHost())).toThrow(
      "That's a path on this computer; sandbox-1 is a Linux host. Pick a folder on sandbox-1.",
    );
  });
});
