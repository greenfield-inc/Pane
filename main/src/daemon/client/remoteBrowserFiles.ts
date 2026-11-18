import { BrowserWindow, session } from 'electron';
import { remotePaneClientController } from './remotePaneClient';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError, paneErrorText } from '../../../../shared/paneError';

const fileResponseSchema = boundary.object({ data: boundary.string, contentType: boundary.string });

/** One file of a browser tab's host page, read from the connected host within the page's folder. */
export async function readHostBrowserFile(panelId: string, url: string) {
  const result = await remotePaneClientController.invoke('panels:read-browser-file', [panelId, url], async () => {
    throw new Error('Remote host is disconnected');
  });
  return decodeBoundary(result, fileResponseSchema);
}

/** A remote file webview must never fall back to reading the client's disk. */
export function prepareRemoteBrowserFiles(panelId: string) {
  const controller = remotePaneClientController;
  const state = controller.getConnectionState();
  if (state.mode !== 'remote') return { partition: null };
  const profileId = state.activeProfileId;
  const baseUrl = state.activeBaseUrl;
  const onSameHost = () => {
    const current = controller.getConnectionState();
    return current.mode === 'remote' && current.activeProfileId === profileId && current.activeBaseUrl === baseUrl;
  };
  const partition = `remote-browser:${encodeURIComponent(profileId ?? '')}:${encodeURIComponent(baseUrl ?? '')}:${encodeURIComponent(panelId)}`;
  const browserSession = session.fromPartition(partition);
  if (!browserSession.protocol.isProtocolHandled('file')) {
    browserSession.protocol.handle('file', async (request) => {
      try {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        if (!onSameHost()) return new Response('The connected host has changed', { status: 403 });
        const file = await readHostBrowserFile(panelId, request.url);
        if (!onSameHost()) return new Response('The connected host has changed', { status: 403 });
        return new Response(new Uint8Array(Buffer.from(file.data, 'base64')), {
          headers: { 'Content-Type': file.contentType, 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        // The host names a file outside the page's folder and how to fix the page. The tab shows
        // it too, since a refused stylesheet or script never appears in the page.
        const refusal = error instanceof PaneError && error.code === 'ERR_BROWSER_FILE_OUTSIDE_FOLDER' ? error : null;
        if (refusal && onSameHost()) {
          const detail = { panelId, message: refusal.message, next: refusal.next };
          for (const window of BrowserWindow.getAllWindows()) window.webContents.send('browser-panel:file-refused', detail);
        }
        return new Response(refusal ? paneErrorText(refusal) : 'Unable to read this file from the host. Reopen the file on the host and check the connection.', {
          status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    });
  }
  return { partition };
}
