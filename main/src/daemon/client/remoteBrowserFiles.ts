import { session } from 'electron';
import { remotePaneClientController } from './remotePaneClient';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

const fileResponseSchema = boundary.object({ data: boundary.string, contentType: boundary.string });

/** A remote file webview must never fall back to reading the client's disk. */
export function prepareRemoteBrowserFiles(panelId: string) {
  const controller = remotePaneClientController;
  const state = controller.getConnectionState();
  if (state.mode !== 'remote') return { partition: null };
  const profileId = state.activeProfileId;
  const baseUrl = state.activeBaseUrl;
  const partition = `remote-browser:${encodeURIComponent(profileId ?? '')}:${encodeURIComponent(baseUrl ?? '')}:${encodeURIComponent(panelId)}`;
  const browserSession = session.fromPartition(partition);
  if (!browserSession.protocol.isProtocolHandled('file')) {
    browserSession.protocol.handle('file', async (request) => {
      try {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        const current = controller.getConnectionState();
        if (current.mode !== 'remote' || current.activeProfileId !== profileId || current.activeBaseUrl !== baseUrl) {
          return new Response('The connected host has changed', { status: 403 });
        }
        const result = await controller.invoke('panels:read-browser-file', [panelId, request.url], async () => {
          throw new Error('Remote host is disconnected');
        });
        const file = decodeBoundary(result, fileResponseSchema);
        const after = controller.getConnectionState();
        if (after.mode !== 'remote' || after.activeProfileId !== profileId || after.activeBaseUrl !== baseUrl) {
          return new Response('The connected host has changed', { status: 403 });
        }
        return new Response(new Uint8Array(Buffer.from(file.data, 'base64')), {
          headers: { 'Content-Type': file.contentType, 'Cache-Control': 'no-store' },
        });
      } catch {
        return new Response('Unable to read this file from the host. Reopen the file on the host and check the connection.', {
          status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    });
  }
  return { partition };
}
