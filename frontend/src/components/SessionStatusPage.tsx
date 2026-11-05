import { useEffect, useRef, useState } from 'react';
import type { OrchestrationSessionOverview } from '../../../shared/types/orchestrationSession';
import { SHARED_BROWSER_PARTITION } from '../../../shared/constants/browserPartitions';
import { panelApi } from '../services/panelApi';
import { activatePanel } from '../services/openFileInEditor';
import { usePanelStore } from '../stores/panelStore';
import { useConfigStore } from '../stores/configStore';
import { previewHtmlFileInBrowser } from './panels/editor/previewHtmlFile';

/** Where an orchestrator writes its Session's status page, relative to the Session folder. */
const SESSION_STATUS_PAGE = 'session/index.html';

/**
 * The file URL of the Session's status page, or null while it has none. Rechecks when
 * the Session overview changes (each refresh). A client of a remote host reads host files
 * only through a browser tab's grant, so it shows no page here.
 */
export function useSessionStatusPage(folderSessionId: string, recheck: OrchestrationSessionOverview | null): string | null {
  const remote = useConfigStore(state => state.config?.remoteDaemon?.client.mode === 'remote');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (remote) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const request = { sessionId: folderSessionId, filePath: SESSION_STATUS_PAGE };
      const exists = await window.electronAPI.invoke('file:exists', request) === true;
      const resolved: { success: boolean; url?: string } | null = exists ? await window.electronAPI.invoke('file:getPath', request) : null;
      if (!cancelled) setUrl(resolved?.success && resolved.url ? resolved.url : null);
    })().catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [folderSessionId, recheck, remote]);
  return url;
}

/** Opens the status page full-size in the Session's split, in the tab already showing it. */
export function openStatusPageBesideChat(folderSessionId: string): Promise<void> {
  return previewHtmlFileInBrowser(folderSessionId, SESSION_STATUS_PAGE);
}

function samePage(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0];
}

/** A link the page follows to anything but itself opens as a browser tab beside chat. */
async function openLinkBesideChat(sessionId: string, url: string): Promise<void> {
  let title = 'Page';
  try { title = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || new URL(url).hostname || title; } catch { /* malformed URL */ }
  const panel = await panelApi.createPanel({ sessionId, type: 'browser', title, initialState: { customState: { currentUrl: url } } });
  usePanelStore.getState().addPanel(panel);
  await activatePanel(sessionId, panel.id);
}

/**
 * The status page in the Overview tab. pane:// links work because it loads as a local file
 * (main routes them); any other link opens beside chat, so the sidebar keeps the page.
 * Its first load stays behind a mask; the page's own 60-second reloads repaint in place.
 */
export function SessionStatusPage({ url, folderSessionId }: { url: string; folderSessionId: string }) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLoaded(false);
    const webview = webviewRef.current;
    if (!webview) return;
    const reveal = () => setLoaded(true);
    const leave = (event: Electron.DidStartNavigationEvent) => {
      // Main routes pane:// links itself; only web and file pages open beside chat.
      if (!event.isMainFrame || event.isInPlace || samePage(event.url, url) || !/^(https?|file):/i.test(event.url)) return;
      webview.stop();
      void openLinkBesideChat(folderSessionId, event.url).catch(error => {
        console.error('[SessionStatusPage] Did not open the link beside chat:', error);
      });
    };
    // A navigation that stop() was too late for still lands on the page again.
    const returnToPage = (event: Electron.DidNavigateEvent) => {
      if (!samePage(event.url, url)) void webview.loadURL(url);
    };
    webview.addEventListener('did-stop-loading', reveal);
    webview.addEventListener('did-start-navigation', leave);
    webview.addEventListener('did-navigate', returnToPage);
    return () => {
      webview.removeEventListener('did-stop-loading', reveal);
      webview.removeEventListener('did-start-navigation', leave);
      webview.removeEventListener('did-navigate', returnToPage);
    };
  }, [url, folderSessionId]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <webview ref={webviewRef} src={url} partition={SHARED_BROWSER_PARTITION}
        className="flex-1 border-0" style={{ display: 'inline-flex' }} />
      {!loaded && <div role="status" aria-label="Loading the status page" className="absolute inset-0 bg-surface-primary">
        <div aria-hidden="true" className="flex animate-pulse flex-col gap-3 p-3">
          <div className="h-5 w-1/2 rounded bg-surface-secondary" />
          <div className="h-8 w-full rounded bg-surface-secondary" />
          <div className="h-40 w-full rounded bg-surface-secondary" />
        </div>
      </div>}
    </div>
  );
}
