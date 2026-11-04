import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PaneError } from '../../../shared/paneError';
import { clearBrowserData } from './browserData';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function seedProfile(): Promise<string> {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-browser-data-'));
  directories.push(userData);
  for (const name of ['pane-browser', 'pane-docs', 'project-3', 'project-__orchestration_session_x__']) {
    await fs.mkdir(path.join(userData, 'Partitions', name, 'Local Storage'), { recursive: true });
    await fs.writeFile(path.join(userData, 'Partitions', name, 'Cookies'), 'cookie rows');
  }
  return userData;
}

function createSharedSession() {
  return {
    clearStorageData: vi.fn(() => Promise.resolve()),
    clearCache: vi.fn(() => Promise.resolve()),
    clearAuthCache: vi.fn(() => Promise.resolve()),
    closeAllConnections: vi.fn(() => Promise.resolve()),
  };
}

async function partitionsOf(userData: string): Promise<string[]> {
  return (await fs.readdir(path.join(userData, 'Partitions'))).sort();
}

describe('clearBrowserData', () => {
  it('signs out of the shared store, deletes the old per-project and per-Session stores, and reloads open tabs', async () => {
    const userData = await seedProfile();
    const sharedSession = createSharedSession();
    const reloadBrowserTabs = vi.fn();

    await clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs });

    expect(sharedSession.clearStorageData).toHaveBeenCalledTimes(1);
    expect(sharedSession.clearCache).toHaveBeenCalledTimes(1);
    expect(await partitionsOf(userData)).toEqual(['pane-browser', 'pane-docs']);
    await expect(fs.readFile(path.join(userData, 'Partitions', 'pane-docs', 'Cookies'), 'utf8')).resolves.toBe('cookie rows');
    expect(reloadBrowserTabs).toHaveBeenCalledTimes(1);
  });

  it('removes a link inside Partitions without touching the folder it points to', async () => {
    const userData = await seedProfile();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-browser-outside-'));
    directories.push(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'not browser data');
    // A junction needs no Windows symlink privilege and is a plain symlink elsewhere.
    await fs.symlink(outside, path.join(userData, 'Partitions', 'project-linked'), 'junction');

    await clearBrowserData({ userDataPath: userData, sharedSession: createSharedSession(), reloadBrowserTabs: vi.fn() });

    expect(await partitionsOf(userData)).toEqual(['pane-browser', 'pane-docs']);
    await expect(fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).resolves.toBe('not browser data');
  });

  it('succeeds when the profile has no Partitions folder yet', async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-browser-data-'));
    directories.push(userData);
    const sharedSession = createSharedSession();

    await clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs: vi.fn() });

    expect(sharedSession.clearStorageData).toHaveBeenCalledTimes(1);
  });

  it('reports a store it could not delete, still clears the shared store, and deletes it on the next run', async () => {
    const userData = await seedProfile();
    const lockedStore = path.join(userData, 'Partitions', 'project-3');
    const sharedSession = createSharedSession();
    const reloadBrowserTabs = vi.fn();
    const removeLocked = vi.fn(async (target: string) => {
      if (target === lockedStore) throw new Error('EBUSY: resource busy or locked');
      await fs.rm(target, { recursive: true, force: true });
    });

    const run = clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs, removeStore: removeLocked });

    await expect(run).rejects.toBeInstanceOf(PaneError);
    await expect(run).rejects.toMatchObject({
      code: 'browser-data-cleanup-incomplete',
      message: `Pane cleared your logins but couldn't remove some older browser data at ${lockedStore}: EBUSY: resource busy or locked.`,
      next: 'Close any open browser tabs and run Clear browser data again.',
    });
    expect(sharedSession.clearStorageData).toHaveBeenCalledTimes(1);
    expect(reloadBrowserTabs).toHaveBeenCalledTimes(1);
    expect(await partitionsOf(userData)).toEqual(['pane-browser', 'pane-docs', 'project-3']);

    await clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs });

    expect(await partitionsOf(userData)).toEqual(['pane-browser', 'pane-docs']);
  });

  it('forgets saved HTTP sign-ins and drops open connections before reloading tabs', async () => {
    const userData = await seedProfile();
    const order: string[] = [];
    const sharedSession = {
      ...createSharedSession(),
      clearAuthCache: vi.fn(async () => { order.push('auth-cache-cleared'); }),
      closeAllConnections: vi.fn(async () => { order.push('connections-closed'); }),
    };

    await clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs: () => order.push('tabs-reloaded') });

    expect(order).toEqual(['auth-cache-cleared', 'connections-closed', 'tabs-reloaded']);
  });

  it('reports saved HTTP sign-ins it could not forget after reloading tabs', async () => {
    const userData = await seedProfile();
    const sharedSession = { ...createSharedSession(), clearAuthCache: vi.fn(() => Promise.reject(new Error('network service crashed'))) };
    const reloadBrowserTabs = vi.fn();

    const run = clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs });

    await expect(run).rejects.toMatchObject({
      code: 'browser-data-clear-incomplete',
      message: "Pane cleared cookies and site data but couldn't clear saved site passwords: network service crashed. Sites that use them may still be signed in.",
      next: 'Run Clear browser data again. If it fails again, quit and reopen Pane, then run it once more.',
    });
    expect(reloadBrowserTabs).toHaveBeenCalledTimes(1);
    expect(await partitionsOf(userData)).toEqual(['pane-browser', 'pane-docs']);
  });

  it('finishes the cleanup and reloads tabs when the cache cannot be cleared, then succeeds on a retry', async () => {
    const userData = await seedProfile();
    const sharedSession = createSharedSession();
    sharedSession.clearCache.mockRejectedValueOnce(new Error('cache is busy'));
    const reloadBrowserTabs = vi.fn();

    const run = clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs });

    await expect(run).rejects.toBeInstanceOf(PaneError);
    await expect(run).rejects.toMatchObject({
      code: 'browser-data-clear-incomplete',
      message: "Pane cleared your logins but couldn't clear the browser cache: cache is busy. Pages may still show copies saved before you cleared.",
      next: 'Run Clear browser data again. If it fails again, quit and reopen Pane, then run it once more.',
    });
    expect(sharedSession.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(sharedSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(reloadBrowserTabs).toHaveBeenCalledTimes(1);
    expect(await partitionsOf(userData)).toEqual(['pane-browser', 'pane-docs']);

    await expect(clearBrowserData({ userDataPath: userData, sharedSession, reloadBrowserTabs })).resolves.toBeUndefined();
    expect(sharedSession.clearCache).toHaveBeenCalledTimes(2);
  });
});
