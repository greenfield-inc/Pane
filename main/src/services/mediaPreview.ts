import { randomUUID } from 'crypto';
import { ipcMain, protocol, shell, type WebContents } from 'electron';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { filePreviewKind } from '../../../shared/utils/filePreview';
import { listArchive, listSqlite } from './filePreviewListing';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { streamMediaFile } from './mediaStream';
import { revealInFileManager } from '../utils/revealInFileManager';

const requestSchema = boundary.object({ sessionId: boundary.string, filePath: boundary.string });
const pathSchema = boundary.object({ success: boundary.literal(true), path: boundary.string, url: boundary.string });

type PreviewHandler = (
  event: { sender: Pick<WebContents, 'id' | 'isDestroyed' | 'once'> },
  ...args: PaneCommandValue[]
) => PaneCommandValue | Promise<PaneCommandValue>;

/** Electron registration and host-state boundary; file validation/streaming stay real. */
export interface MediaPreviewRuntime {
  handleIpc(channel: string, handler: PreviewHandler): void;
  handleProtocol(handler: (request: Request) => Promise<Response>): void;
  isRemote(): boolean;
}

const electronRuntime: MediaPreviewRuntime = {
  handleIpc: (channel, handler) => ipcMain.handle(channel, handler),
  handleProtocol: handler => protocol.handle('pane-media', handler),
  isRemote: () => remotePaneClientController.getConnectionState().mode === 'remote',
};

/** Capabilities are local, scoped to the issuing renderer, and revoked on tab close. */
export function registerMediaPreview(commandRegistry: PaneCommandRegistry, runtime: MediaPreviewRuntime = electronRuntime): void {
  const grants = new Map<string, { owner: number; sessionId: string; filePath: string }>();
  const owners = new Set<number>();
  const requireLocal = () => {
    if (runtime.isRemote()) {
      throw new Error('File preview is only available on the local host');
    }
  };
  const resolve = async (request: { sessionId: string; filePath: string }) => {
    requireLocal();
    // Reuse the worktree boundary, symlink checks and Windows/WSL conversion.
    const result = decodeBoundary(await commandRegistry.invoke('file:getPath', [request]), pathSchema);
    requireLocal();
    return result;
  };

  runtime.handleIpc('file:preview-url', async (event, raw: PaneCommandValue) => {
    const request = decodeBoundary(raw, requestSchema);
    if (!filePreviewKind(request.filePath)) throw new Error('No preview for this file type');
    await resolve(request);
    if (event.sender.isDestroyed()) throw new Error('Preview closed');
    const token = randomUUID();
    grants.set(token, { owner: event.sender.id, ...request });
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
  runtime.handleIpc('file:preview-list', async (_event, raw: PaneCommandValue) => {
    const request = decodeBoundary(raw, requestSchema);
    const kind = filePreviewKind(request.filePath);
    const file = await resolve(request);
    if (kind === 'archive') return listArchive(file.path);
    if (kind === 'sqlite') return listSqlite(file.path);
    throw new Error('No listing for this file type');
  });
  runtime.handleIpc('file:preview-action', async (_event, raw: PaneCommandValue, rawAction: PaneCommandValue) => {
    const action = decodeBoundary(rawAction, boundary.enumeration('open', 'reveal'));
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
      if (!grant) return new Response(null, { status: 403 });
      const file = await resolve({ sessionId: grant.sessionId, filePath: grant.filePath });
      return await streamMediaFile(file.path, request);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
