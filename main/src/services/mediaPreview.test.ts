import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import type { AppServices } from '../ipc/types';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { registerFileHandlers } from '../ipc/file';
import { registerMediaPreview, type MediaPreviewRuntime, type RemoteMediaHost } from './mediaPreview';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { hashRemoteDaemonToken } from '../daemon/auth';
import { PaneRemoteHttpApiServer } from '../daemon/httpApiServer';
import { RemotePaneClient } from '../daemon/client/remotePaneClient';

type PreviewHandler = Parameters<MediaPreviewRuntime['handleIpc']>[1];
const adapters = {
  handlers: new Map<string, PreviewHandler>(),
  protocols: new Map<string, (request: Request) => Promise<Response>>(),
};
let remoteHost: RemoteMediaHost | null = null;
const opened: string[] = [];
const runtime: MediaPreviewRuntime = {
  openPath: async filePath => { opened.push(filePath); return ''; },
  handleIpc: (name, handler) => { adapters.handlers.set(name, handler); },
  handleProtocol: handler => { adapters.protocols.set('pane-media', handler); },
  remoteHost: () => remoteHost,
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
const servers: PaneRemoteHttpApiServer[] = [];

beforeEach(async () => {
  adapters.handlers.clear(); adapters.protocols.clear(); remoteHost = null; opened.length = 0;
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
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.stop();
  await fs.rm(directory, { recursive: true, force: true });
});

async function invoke(channel: string, owner: Owner, ...args: PaneCommandValue[]) {
  const handler = adapters.handlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler({ sender: owner }, ...args);
}
async function acquire(owner: Owner, filePath = 'clip.mp4') {
  const result = await invoke('file:preview-url', owner, { sessionId, filePath });
  return decodeBoundary(result, boundary.string);
}
async function fetchPreview(url: string, range = 'bytes=2-5') {
  const handler = adapters.protocols.get('pane-media');
  if (!handler) throw new Error('Preview protocol not registered');
  const response = await handler(new Request(url, { headers: { Range: range } }));
  return { status: response.status, body: await response.text(), range: response.headers.get('Content-Range') };
}

/** The same process serves as host (HTTP API over the real file commands) and as remote client. */
async function connectToHost(id = 'host-1'): Promise<{ host: RemoteMediaHost; baseUrl: string }> {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  config.host.clients = [{ id: 'client-1', label: 'Laptop', createdAt: new Date(0).toISOString(), tokenHash: hashRemoteDaemonToken('secret-token') }];
  const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) });
  servers.push(server);
  await server.start();
  const address = server.getAddress();
  if (!address) throw new Error('Host is not listening');
  const baseUrl = `http://${address.host}:${address.port}`;
  const client = new RemotePaneClient({ id, label: 'Host', baseUrl, token: 'secret-token', transport: 'http+sse' });
  return {
    baseUrl,
    host: { id, invoke: (channel, args) => client.invoke(channel, args), fetchMedia: (file, request) => client.fetchMedia(file, request) },
  };
}

it('issues a working range capability that only its owner can release', async () => {
  const owner = new Owner(1);
  const url = await acquire(owner);
  expect(await fetchPreview(url)).toMatchObject({ status: 206, body: '2345' });
  await invoke('file:release-preview', new Owner(2), url);
  expect(await fetchPreview(url)).toMatchObject({ status: 206, body: '2345' });
  await invoke('file:release-preview', owner, url);
  expect(await fetchPreview(url)).toMatchObject({ status: 403, body: '' });
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

it('streams byte ranges of a remote host\'s file through the client\'s capability', async () => {
  const { host } = await connectToHost();
  remoteHost = host;
  const url = await acquire(new Owner(1));
  expect(await fetchPreview(url)).toEqual({ status: 206, body: '2345', range: 'bytes 2-5/10' });
  expect(await fetchPreview(url, 'bytes=8-')).toEqual({ status: 206, body: '89', range: 'bytes 8-9/10' });
});

it('opens a remote host\'s file with a system app on the client from a local copy', async () => {
  remoteHost = (await connectToHost()).host;
  await invoke('file:preview-action', new Owner(1), { sessionId, filePath: 'clip.mp4' }, 'open');
  expect(opened).toHaveLength(1);
  expect(path.basename(opened[0])).toBe('clip.mp4');
  expect(opened[0].startsWith(worktree)).toBe(false);
  expect(await fs.readFile(opened[0], 'utf8')).toBe('0123456789');
  await expect(invoke('file:preview-action', new Owner(1), { sessionId, filePath: 'clip.mp4' }, 'reveal')).rejects.toThrow('host');
  await expect(invoke('file:preview-action', new Owner(1), { sessionId, filePath: '../outside.mp4' }, 'open')).rejects.toThrow();
  expect(opened).toHaveLength(1);
});

it('binds a capability to the host that issued it', async () => {
  const owner = new Owner(1);
  const local = await acquire(owner);
  const first = await connectToHost('host-1');
  remoteHost = first.host;
  expect((await fetchPreview(local)).status).toBe(403);
  const remote = await acquire(owner);
  remoteHost = (await connectToHost('host-2')).host;
  expect((await fetchPreview(remote)).status).toBe(403);
  remoteHost = null;
  expect((await fetchPreview(remote)).status).toBe(403);
});

it('keeps the host\'s worktree boundary for remote previews', async () => {
  const { host, baseUrl } = await connectToHost();
  remoteHost = host;
  await expect(acquire(new Owner(1), '../outside.mp4')).rejects.toThrow();
  const media = (filePath: string, headers: Record<string, string> = { Authorization: 'Bearer secret-token' }) =>
    fetch(`${baseUrl}/media?sessionId=${sessionId}&filePath=${encodeURIComponent(filePath)}`, { headers }).then(response => response.status);
  expect(await media('clip.mp4')).toBe(200);
  expect(await media('clip.mp4', {})).toBe(401);
  expect(await media('../outside.mp4')).toBe(404);
  await fs.writeFile(path.join(worktree, 'notes.txt'), 'not a preview kind');
  expect(await media('notes.txt')).toBe(404);
});

it('revalidates containment after the worktree path becomes an outside symlink', async () => {
  const owner = new Owner(1); const url = await acquire(owner);
  expect((await fetchPreview(url)).status).toBe(206);
  await fs.rm(path.join(worktree, 'clip.mp4'));
  await fs.symlink(path.join(directory, 'outside.mp4'), path.join(worktree, 'clip.mp4'));
  expect(await fetchPreview(url)).toMatchObject({ status: 404, body: '' });
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
