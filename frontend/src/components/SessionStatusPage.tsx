import { useEffect, useRef, useState } from 'react';
import { SHARED_BROWSER_PARTITION } from '../../../shared/constants/browserPartitions';
import { openBesideChat } from '../hooks/useSessionStatusPage';

function samePage(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0];
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
      void openBesideChat(folderSessionId, event.url).catch(error => {
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
