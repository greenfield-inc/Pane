import { randomUUID } from 'crypto';
import { ipcMain, protocol, shell, type WebContents } from 'electron';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { filePreviewKind } from '../../../shared/utils/filePreview';
import { listArchive, listSqlite } from './filePreviewListing';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { previewPathSchema, streamMediaFile, type PreviewFile } from './mediaStream';
import { revealInFileManager } from '../utils/revealInFileManager';

const requestSchema = boundary.object({ sessionId: boundary.string, filePath: boundary.string });

type PreviewHandler = (
  event: { sender: Pick<WebContents, 'id' | 'isDestroyed' | 'once'> },
  ...args: PaneCommandValue[]
) => PaneCommandValue | Promise<PaneCommandValue>;

/** The connected host when this desktop runs in remote mode. */
export interface RemoteMediaHost {
  /** Distinguishes hosts, so a capability never reads from a host it was not issued for. */
  id: string;
  invoke(channel: string, args: PaneCommandValue[]): Promise<PaneCommandValue>;
  fetchMedia(file: PreviewFile, request: Request): Promise<Response>;
}

/** Electron registration and host-state boundary; file validation/streaming stay real. */
export interface MediaPreviewRuntime {
  handleIpc(channel: string, handler: PreviewHandler): void;
  handleProtocol(handler: (request: Request) => Promise<Response>): void;
  remoteHost(): RemoteMediaHost | null;
}

const electronRuntime: MediaPreviewRuntime = {
  handleIpc: (channel, handler) => ipcMain.handle(channel, handler),
  handleProtocol: handler => protocol.handle('pane-media', handler),
  remoteHost: () => {
    const client = remotePaneClientController.getActiveRemoteClient();
    if (!client) return null;
    return {
      id: `${client.profile.id}\n${client.profile.baseUrl}`,
      invoke: async (channel, args) => (await client.invoke(channel, args)) ?? null,
      fetchMedia: (file, request) => client.fetchMedia(file, request),
    };
  },
};

/**
 * Capabilities are scoped to the issuing renderer and to the host they were issued for, and
 * revoked on tab close. In remote mode the host checks its worktree boundary on every request.
 */
export function registerMediaPreview(commandRegistry: PaneCommandRegistry, runtime: MediaPreviewRuntime = electronRuntime): void {
  const grants = new Map<string, { owner: number; host: string | null } & PreviewFile>();
  const owners = new Set<number>();
  // Reuse the worktree boundary, symlink checks and Windows/WSL conversion.
  const resolve = async (request: PreviewFile, host: RemoteMediaHost | null = null) =>
    decodeBoundary(await (host ?? commandRegistry).invoke('file:getPath', [request]), previewPathSchema);

  runtime.handleIpc('file:preview-url', async (event, raw: PaneCommandValue) => {
    const request = decodeBoundary(raw, requestSchema);
    if (!filePreviewKind(request.filePath)) throw new Error('No preview for this file type');
    const host = runtime.remoteHost();
    await resolve(request, host);
    if (event.sender.isDestroyed()) throw new Error('Preview closed');
    const token = randomUUID();
    grants.set(token, { owner: event.sender.id, host: host?.id ?? null, ...request });
    if (!owners.has(event.sender.id)) {
      const owner = event.sender.id;
      owners.add(owner);
      event.sender.once('destroyed', () => {
        for (const [key, grant] of grants) if (grant.owner === owner) grants.delete(key);
        owners.delete(owner);
      });
    }
    return `pane-media://preview/${token}`;
  });
  runtime.handleIpc('file:release-preview', (event, rawUrl: PaneCommandValue) => {
    const url = decodeBoundary(rawUrl, boundary.string);
    const token = url.replace('pane-media://preview/', '');
    if (grants.get(token)?.owner === event.sender.id) grants.delete(token);
    return undefined;
  });
  // Daemon-owned, so a remote desktop's listing runs on the host that has the file.
  commandRegistry.register('file:preview-list', async (raw: PaneCommandValue) => {
    const request = decodeBoundary(raw, requestSchema);
    const kind = filePreviewKind(request.filePath);
    const file = await resolve(request);
    if (kind === 'archive') return listArchive(file.path);
    if (kind === 'sqlite') return listSqlite(file.path);
    throw new Error('No listing for this file type');
  });
  runtime.handleIpc('file:preview-action', async (_event, raw: PaneCommandValue, rawAction: PaneCommandValue) => {
    const action = decodeBoundary(rawAction, boundary.enumeration('open', 'reveal'));
    if (runtime.remoteHost()) throw new Error('Open and reveal work only on the host');
    const file = await resolve(decodeBoundary(raw, requestSchema));
    if (action === 'open') {
      const error = await shell.openPath(file.path);
      if (error) throw new Error(error);
    } else {
      await revealInFileManager(file.path);
    }
  });
  runtime.handleProtocol(async request => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
      const url = new URL(request.url);
      const grant = url.hostname === 'preview' ? grants.get(url.pathname.slice(1)) : undefined;
      const host = runtime.remoteHost();
      if (!grant || grant.host !== (host?.id ?? null)) return new Response(null, { status: 403 });
      const file = { sessionId: grant.sessionId, filePath: grant.filePath };
      if (host) return await host.fetchMedia(file, request);
      return await streamMediaFile((await resolve(file)).path, request);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
