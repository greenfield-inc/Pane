import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import type { AppServices } from '../ipc/types';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { registerFileHandlers } from '../ipc/file';
import { registerMediaPreview, type MediaPreviewRuntime } from './mediaPreview';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

type PreviewHandler = Parameters<MediaPreviewRuntime['handleIpc']>[1];
const adapters = {
  handlers: new Map<string, PreviewHandler>(),
  protocols: new Map<string, (request: Request) => Promise<Response>>(),
  remote: false,
};
const runtime: MediaPreviewRuntime = {
  handleIpc: (name, handler) => { adapters.handlers.set(name, handler); },
  handleProtocol: handler => { adapters.protocols.set('pane-media', handler); },
  isRemote: () => adapters.remote,
};

class Owner extends EventEmitter {
  private destroyed = false;
  constructor(readonly id: number) { super(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}
let directory: string;
let worktree: string;
let registry: PaneCommandRegistry;
const sessionId = '__pane_chat_session__';

beforeEach(async () => {
  adapters.handlers.clear(); adapters.protocols.clear(); adapters.remote = false;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-capabilities-'));
  worktree = path.join(directory, 'worktree');
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(worktree, 'clip.mp4'), '0123456789');
  await fs.writeFile(path.join(directory, 'outside.mp4'), 'private outside data');
  registry = new PaneCommandRegistry();
  // SAFETY: File handlers only need the hidden Session's root and project lookup.
  const services = { sessionManager: {
    getSession: (id: string) => ({ id, isHidden: true, worktreePath: worktree }),
    getProjectContext: () => undefined,
  } } as AppServices;
  registerFileHandlers(ipcMain, services, registry);
  registerMediaPreview(registry, runtime);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

async function invoke(channel: string, owner: Owner, ...args: PaneCommandValue[]) {
  const handler = adapters.handlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler({ sender: owner }, ...args);
}
async function acquire(owner: Owner, filePath = 'clip.mp4') {
  const result = await invoke('file:preview-url', owner, { sessionId, filePath });
  return decodeBoundary(result, boundary.string);
}
async function fetchPreview(url: string) {
  const handler = adapters.protocols.get('pane-media');
  if (!handler) throw new Error('Preview protocol not registered');
  const response = await handler(new Request(url, { headers: { Range: 'bytes=2-5' } }));
  return { status: response.status, body: await response.text() };
}

it('issues a working range capability that only its owner can release', async () => {
  const owner = new Owner(1);
  const url = await acquire(owner);
  expect(await fetchPreview(url)).toEqual({ status: 206, body: '2345' });
  await invoke('file:release-preview', new Owner(2), url);
  expect(await fetchPreview(url)).toEqual({ status: 206, body: '2345' });
  await invoke('file:release-preview', owner, url);
  expect(await fetchPreview(url)).toEqual({ status: 403, body: '' });
});

it('revokes all grants for a destroyed owner without revoking another renderer', async () => {
  const owner = new Owner(1);
  const first = await acquire(owner); const second = await acquire(owner);
  const other = await acquire(new Owner(2));
  owner.destroy();
  expect((await fetchPreview(first)).status).toBe(403);
  expect((await fetchPreview(second)).status).toBe(403);
  expect((await fetchPreview(other)).status).toBe(206);
  await expect(acquire(owner)).rejects.toThrow('Preview closed');
});

it('refuses remote issuance and blocks an existing capability after switching remote', async () => {
  const owner = new Owner(1); const url = await acquire(owner);
  adapters.remote = true;
  await expect(acquire(owner)).rejects.toThrow('local host');
  expect((await fetchPreview(url)).status).toBe(404);
});

it('revalidates containment after the worktree path becomes an outside symlink', async () => {
  const owner = new Owner(1); const url = await acquire(owner);
  expect((await fetchPreview(url)).status).toBe(206);
  await fs.rm(path.join(worktree, 'clip.mp4'));
  await fs.symlink(path.join(directory, 'outside.mp4'), path.join(worktree, 'clip.mp4'));
  expect(await fetchPreview(url)).toEqual({ status: 404, body: '' });
  await expect(acquire(owner, '../outside.mp4')).rejects.toThrow();
});

it('does not issue a capability if its owner dies while path validation is pending', async () => {
  const owner = new Owner(1);
  const original = registry.invoke.bind(registry);
  let resume: () => void = () => { throw new Error('Validation did not start'); };
  vi.spyOn(registry, 'invoke').mockImplementation(async (channel, args) => {
    await new Promise<void>(resolve => { resume = resolve; });
    return original(channel, args);
  });
  const pending = acquire(owner);
  owner.destroy(); resume();
  await expect(pending).rejects.toThrow('Preview closed');
});
