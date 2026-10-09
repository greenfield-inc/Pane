import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, extname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
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

/** Remote mode without a connected host is its own state, so it never falls back to local files. */
export type MediaConnection = { kind: 'local' } | { kind: 'remote'; host: RemoteMediaHost | null };

/** Electron registration and host-state boundary; file validation/streaming stay real. */
export interface MediaPreviewRuntime {
  handleIpc(channel: string, handler: PreviewHandler): void;
  handleProtocol(handler: (request: Request) => Promise<Response>): void;
  connection(): MediaConnection;
  /** Resolves to an error message, empty on success, like Electron's shell.openPath. */
  openPath(filePath: string): Promise<string>;
}

const electronRuntime: MediaPreviewRuntime = {
  handleIpc: (channel, handler) => ipcMain.handle(channel, handler),
  handleProtocol: handler => protocol.handle('pane-media', handler),
  openPath: filePath => shell.openPath(filePath),
  connection: () => {
    if (!remotePaneClientController.isRemoteModeActive()) return { kind: 'local' };
    const client = remotePaneClientController.getActiveRemoteClient();
    return {
      kind: 'remote',
      host: client && {
        id: `${client.profile.id}\n${client.profile.baseUrl}`,
        invoke: async (channel, args) => (await client.invoke(channel, args)) ?? null,
        fetchMedia: (file, request) => client.fetchMedia(file, request),
      },
    };
  },
};

/** Host file names can be invalid on the client's OS, such as CON.pdf, NUL.backup.pdf or report?.pdf on Windows. */
function clientSafeName(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const safe = /^[\p{L}\p{N}_-][\p{L}\p{N}_ .()-]{0,99}$/u.test(stem) && !/[ .]$/.test(stem)
    // Windows reserves device names before the first dot, including COM¹ to LPT³.
    && !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *$/iu.test(stem.split('.')[0]);
  return (safe ? stem : 'preview') + (/^\.[A-Za-z0-9]{1,10}$/.test(extension) ? extension : '');
}

/**
 * Capabilities are scoped to the issuing renderer and to the host they were issued for, and
 * revoked on tab close. In remote mode the host checks its worktree boundary on every request.
 */
export function registerMediaPreview(commandRegistry: PaneCommandRegistry, runtime: MediaPreviewRuntime = electronRuntime): void {
  const grants = new Map<string, { owner: number; host: string | null } & PreviewFile>();
  const owners = new Set<number>();
  /** The host to read from, or null when this machine is the host. */
  const currentHost = () => {
    const connection = runtime.connection();
    if (connection.kind === 'local') return null;
    if (!connection.host) throw new Error('The remote host is not connected, so Pane cannot reach this file. Nothing was changed. Reconnect to the host, then try again.');
    return connection.host;
  };
  // Reuse the worktree boundary, symlink checks and Windows/WSL conversion.
  const resolve = async (request: PreviewFile, host: RemoteMediaHost | null = null) =>
    decodeBoundary(await (host ?? commandRegistry).invoke('file:getPath', [request]), previewPathSchema);

  runtime.handleIpc('file:preview-url', async (event, raw: PaneCommandValue) => {
    const request = decodeBoundary(raw, requestSchema);
    if (!filePreviewKind(request.filePath)) throw new Error('No preview for this file type');
    const host = currentHost();
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
  /** System apps run where the file is, so a remote host's file is opened from a client copy. */
  const copyFromHost = async (host: RemoteMediaHost, file: PreviewFile) => {
    const copyFailed = (reason: string) => new Error(
      `Could not copy ${basename(file.filePath)} from the host to open it here: ${reason}. Nothing was changed. Check the connection to the host, then try again.`,
    );
    const response = await host.fetchMedia(file, new Request('pane-media://preview/open'))
      .catch((error: unknown) => { throw copyFailed(error instanceof Error ? error.message : String(error)); });
    if (response.status !== 200 || !response.body) throw copyFailed(`the host answered HTTP ${response.status}`);
    const directory = await mkdtemp(join(tmpdir(), 'pane-remote-open-'));
    const target = join(directory, clientSafeName(file.filePath));
    try {
      // SAFETY: the DOM and Node typings describe the same WHATWG ReadableStream.
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), createWriteStream(target));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return target;
  };
  runtime.handleIpc('file:preview-action', async (_event, raw: PaneCommandValue, rawAction: PaneCommandValue) => {
    const action = decodeBoundary(rawAction, boundary.enumeration('open', 'reveal'));
    const request = decodeBoundary(raw, requestSchema);
    const host = currentHost();
    if (host && action === 'reveal') {
      throw new Error('Reveal in folder works only on the host, because this file is on another machine. Nothing was changed. Use Open to view a copy here, or reveal it from Pane on the host.');
    }
    if (action === 'open') {
      const target = host ? await copyFromHost(host, request) : (await resolve(request)).path;
      const error = await runtime.openPath(target);
      if (error) {
        // A successful copy stays for the system app; a failed open leaves nothing behind.
        if (host) await rm(dirname(target), { recursive: true, force: true });
        throw new Error(`Could not open ${basename(request.filePath)} with the default app: ${error}. ${host ? 'The copy made for it was removed.' : 'Nothing was changed.'} Set a default app for this file type, then try again.`);
      }
    } else {
      await revealInFileManager((await resolve(request)).path);
    }
  });
  runtime.handleProtocol(async request => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
      const url = new URL(request.url);
      const grant = url.hostname === 'preview' ? grants.get(url.pathname.slice(1)) : undefined;
      const host = currentHost();
      if (!grant || grant.host !== (host?.id ?? null)) return new Response(null, { status: 403 });
      const file = { sessionId: grant.sessionId, filePath: grant.filePath };
      if (host) return await host.fetchMedia(file, request);
      return await streamMediaFile((await resolve(file)).path, request);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
