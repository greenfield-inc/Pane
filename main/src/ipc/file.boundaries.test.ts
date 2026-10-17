import type { IpcMain } from 'electron';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { PathResolver } from '../utils/pathResolver';
import type { AppServices } from './types';
import { registerFileHandlers } from './file';

let directory: string;
let root: string;
let outside: string;
let registry: PaneCommandRegistry;
let reveal: ReturnType<typeof vi.fn>;
let showInFolder: (request: PaneCommandValue) => Promise<PaneCommandValue>;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'pane-file-boundaries-')));
  root = join(directory, 'repo');
  outside = join(directory, 'outside');
  mkdirSync(join(root, 'nested'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  writeFileSync(join(root, 'nested', 'allowed.txt'), 'inside');
  symlinkSync(outside, join(root, 'escape'), 'dir');
  symlinkSync(join(outside, 'missing.txt'), join(root, 'dangling.txt'));
  const context = { project: { path: root }, pathResolver: new PathResolver({ path: root }) };
  // SAFETY: This fixture supplies the session/root lookup boundaries used by these file handlers.
  const services = { sessionManager: {
    getSession: () => ({ id: 'pane', worktreePath: root }),
    getProjectContext: () => context,
    getProjectContextByProjectId: () => context,
  } } as AppServices;
  const ipc: Pick<IpcMain, 'handle'> = { handle: (channel, handler) => {
    if (channel === 'file:showInFolder') {
      // SAFETY: The handler does not inspect its Electron event argument.
      showInFolder = request => handler({} as Electron.IpcMainInvokeEvent, request);
    }
  } };
  registry = new PaneCommandRegistry();
  reveal = vi.fn(async () => {});
  // SAFETY: Only channel binding uses Electron here.
  registerFileHandlers(ipc as IpcMain, services, registry, reveal);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.each(['file:exists', 'file:list', 'file:read-project', 'file:write-project', 'file:resolveAbsolutePath', 'file:showInFolder'])('rejects symlink escapes through %s', async channel => {
  const request = { sessionId: 'pane', projectId: 1, filePath: 'escape/secret.txt',
    path: channel === 'file:list' ? 'escape' : 'escape/secret.txt', content: 'overwritten' };
  const result = channel === 'file:showInFolder' ? await showInFolder(request) : await registry.invoke(channel, [request]);
  if (channel === 'file:exists') expect(result).toBe(false);
  else expect(result).toMatchObject({ success: false });
  expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  expect(reveal).not.toHaveBeenCalled();
});

it.each(['escape/new/nested/file.txt', 'dangling.txt'])('rejects writes through a missing symlink destination: %s', async filePath => {
  expect(await registry.invoke('file:write', [{ sessionId: 'pane', filePath, content: 'outside' }]))
    .toMatchObject({ success: false });
});

it('reads and creates nested files within the selected root', async () => {
  expect(await registry.invoke('file:read', [{ sessionId: 'pane', filePath: 'nested/allowed.txt' }]))
    .toMatchObject({ success: true, content: 'inside' });
  expect(await registry.invoke('file:write', [{ sessionId: 'pane', filePath: 'new/worktree/file.txt', content: 'inside worktree' }]))
    .toEqual({ success: true });
  expect(await registry.invoke('file:write-project', [{ projectId: 1, filePath: 'new/nested/file.txt', content: 'new inside' }]))
    .toEqual({ success: true });
  expect(await registry.invoke('file:read-project', [{ projectId: 1, filePath: 'new/nested/file.txt' }]))
    .toEqual({ success: true, data: 'new inside' });
});
