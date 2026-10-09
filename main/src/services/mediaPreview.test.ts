import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import type { AppServices } from '../ipc/types';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { registerFileHandlers } from '../ipc/file';
import { registerMediaPreview, type MediaConnection, type MediaPreviewRuntime, type RemoteMediaHost } from './mediaPreview';
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
let connection: MediaConnection = { kind: 'local' };
const opened: string[] = [];
let openError = '';
const runtime: MediaPreviewRuntime = {
  openPath: async filePath => { opened.push(filePath); return openError; },
  handleIpc: (name, handler) => { adapters.handlers.set(name, handler); },
  handleProtocol: handler => { adapters.protocols.set('pane-media', handler); },
  connection: () => connection,
};

class Owner extends EventEmitter {
  private destroyed = false;
  constructor(readonly id: number) { super(); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}
let directory: string;
let worktree: string;
let hostWorktree: string;
let registry: PaneCommandRegistry;
let hostRegistry: PaneCommandRegistry;
const sessionId = '__pane_chat_session__';
const servers: PaneRemoteHttpApiServer[] = [];

beforeEach(async () => {
  adapters.handlers.clear(); adapters.protocols.clear(); connection = { kind: 'local' }; opened.length = 0; openError = '';
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-capabilities-'));
  worktree = path.join(directory, 'worktree');
  hostWorktree = path.join(directory, 'host', 'worktree');
  await fs.mkdir(worktree);
  await fs.mkdir(hostWorktree, { recursive: true });
  // The client has a same-named file, so a remote request that fell back to local disk would show it.
  await fs.writeFile(path.join(worktree, 'clip.mp4'), '0123456789');
  await fs.writeFile(path.join(hostWorktree, 'clip.mp4'), 'HOST-BYTES');
  await fs.writeFile(path.join(directory, 'outside.mp4'), 'private outside data');
  await fs.writeFile(path.join(directory, 'host', 'outside.mp4'), 'private outside data');
  registry = new PaneCommandRegistry();
  hostRegistry = new PaneCommandRegistry();
  registerFileHandlers(ipcMain, servicesFor(worktree), registry);
  registerFileHandlers(ipcMain, servicesFor(hostWorktree), hostRegistry);
  registerMediaPreview(registry, runtime);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.stop();
  await fs.rm(directory, { recursive: true, force: true });
});

function servicesFor(root: string): AppServices {
  // SAFETY: File handlers only need the hidden Session's root and project lookup.
  return { sessionManager: {
    getSession: (id: string) => ({ id, isHidden: true, worktreePath: root }),
    getProjectContext: () => undefined,
  } } as AppServices;
}

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

/** A host with its own worktree behind the real HTTP API, and a client connected to it. */
async function connectToHost(id = 'host-1'): Promise<{ remote: MediaConnection; baseUrl: string }> {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  config.host.clients = [{ id: 'client-1', label: 'Laptop', createdAt: new Date(0).toISOString(), tokenHash: hashRemoteDaemonToken('secret-token') }];
  const server = new PaneRemoteHttpApiServer(hostRegistry, { getConfig: () => ({ remoteDaemon: config }) });
  servers.push(server);
  await server.start();
  const address = server.getAddress();
  if (!address) throw new Error('Host is not listening');
  const baseUrl = `http://${address.host}:${address.port}`;
  const client = new RemotePaneClient({ id, label: 'Host', baseUrl, token: 'secret-token', transport: 'http+sse' });
  const host: RemoteMediaHost = { id, invoke: (channel, args) => client.invoke(channel, args), fetchMedia: (file, request) => client.fetchMedia(file, request) };
  return { baseUrl, remote: { kind: 'remote', host } };
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
  connection = (await connectToHost()).remote;
  const url = await acquire(new Owner(1));
  expect(await fetchPreview(url)).toEqual({ status: 206, body: 'ST-B', range: 'bytes 2-5/10' });
  expect(await fetchPreview(url, 'bytes=8-')).toEqual({ status: 206, body: 'ES', range: 'bytes 8-9/10' });
});

it('opens a remote host\'s file with a system app on the client from a local copy', async () => {
  connection = (await connectToHost()).remote;
  await invoke('file:preview-action', new Owner(1), { sessionId, filePath: 'clip.mp4' }, 'open');
  expect(opened).toHaveLength(1);
  expect(path.basename(opened[0])).toBe('clip.mp4');
  expect(await fs.readFile(opened[0], 'utf8')).toBe('HOST-BYTES');
  await expect(invoke('file:preview-action', new Owner(1), { sessionId, filePath: 'clip.mp4' }, 'reveal')).rejects.toThrow('host');
  await expect(invoke('file:preview-action', new Owner(1), { sessionId, filePath: '../outside.mp4' }, 'open')).rejects.toThrow();
  expect(opened).toHaveLength(1);
});

it('names the client copy so every desktop OS can open it', async () => {
  // A macOS or Linux host can serve names Windows cannot store, so this host answers without a disk.
  const host: RemoteMediaHost = {
    id: 'posix-host',
    invoke: async () => ({ success: true, path: '/srv/worktree/file', url: 'file:///srv/worktree/file' }),
    fetchMedia: async () => new Response('pdf'),
  };
  connection = { kind: 'remote', host };
  const names = ['CON.pdf', 'report?.pdf', 'notes. .pdf', 'NUL.backup.pdf', 'con .pdf', 'COM\u00b9.pdf', 'lpt\u00b2.pdf', 'Q3 report (final).pdf', 'console.pdf'];
  for (const name of names) await invoke('file:preview-action', new Owner(1), { sessionId, filePath: name }, 'open');
  expect(opened.map(file => path.basename(file))).toEqual([
    'preview.pdf', 'preview.pdf', 'preview.pdf', 'preview.pdf', 'preview.pdf', 'preview.pdf', 'preview.pdf',
    'Q3 report (final).pdf', 'console.pdf',
  ]);
});

it('explains a failed copy when the host is unreachable', async () => {
  const unreachable: RemoteMediaHost = {
    id: 'gone',
    invoke: async () => ({ success: true, path: '/srv/clip.mp4', url: 'file:///srv/clip.mp4' }),
    fetchMedia: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:47983'); },
  };
  connection = { kind: 'remote', host: unreachable };
  await expect(invoke('file:preview-action', new Owner(1), { sessionId, filePath: 'clip.mp4' }, 'open')).rejects.toThrow('Could not copy this file from the host');
  expect(opened).toEqual([]);
});

it('removes the client copy when the system app cannot open it', async () => {
  connection = (await connectToHost()).remote;
  openError = 'No application knows how to open this file';
  await expect(invoke('file:preview-action', new Owner(1), { sessionId, filePath: 'clip.mp4' }, 'open')).rejects.toThrow(openError);
  await expect(fs.stat(path.dirname(opened[0]))).rejects.toThrow('ENOENT');
});

it('refuses previews and Open while remote mode has no connected host, never reading client files', async () => {
  const owner = new Owner(1);
  const local = await acquire(owner);
  connection = { kind: 'remote', host: null };
  expect(await fetchPreview(local)).toMatchObject({ status: 404, body: '' });
  await expect(acquire(owner)).rejects.toThrow('not connected');
  await expect(invoke('file:preview-action', owner, { sessionId, filePath: 'clip.mp4' }, 'open')).rejects.toThrow('not connected');
  await expect(invoke('file:preview-action', owner, { sessionId, filePath: 'clip.mp4' }, 'reveal')).rejects.toThrow('not connected');
  expect(opened).toEqual([]);
});

it('binds a capability to the host that issued it', async () => {
  const owner = new Owner(1);
  const local = await acquire(owner);
  connection = (await connectToHost('host-1')).remote;
  expect((await fetchPreview(local)).status).toBe(403);
  const remote = await acquire(owner);
  connection = (await connectToHost('host-2')).remote;
  expect((await fetchPreview(remote)).status).toBe(403);
  connection = { kind: 'local' };
  expect((await fetchPreview(remote)).status).toBe(403);
});

it('keeps the host\'s worktree boundary for remote previews', async () => {
  const { remote, baseUrl } = await connectToHost();
  connection = remote;
  await expect(acquire(new Owner(1), '../outside.mp4')).rejects.toThrow();
  const media = (filePath: string, headers: Record<string, string> = { Authorization: 'Bearer secret-token' }) =>
    fetch(`${baseUrl}/media?sessionId=${sessionId}&filePath=${encodeURIComponent(filePath)}`, { headers }).then(response => response.status);
  expect(await media('clip.mp4')).toBe(200);
  expect(await media('clip.mp4', {})).toBe(401);
  expect(await media('../outside.mp4')).toBe(404);
  await fs.writeFile(path.join(hostWorktree, 'notes.txt'), 'not a preview kind');
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
