import { useEffect, useRef, useState } from 'react';
import { SHARED_BROWSER_PARTITION } from '../../../shared/constants/browserPartitions';
import { openBesideChat } from '../hooks/useSessionStatusPage';
import { Bone, Skeleton, useSkeletonHold, LoadingStatus } from './ui/Skeleton';

function samePage(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0];
}

/**
 * The status page in the Overview tab. pane:// links work because it loads as a local file
 * (main routes them); any other link opens as a browser tab beside chat, so the Overview keeps the page.
 * Its first load stays behind a mask; the page's own 60-second reloads repaint in place.
 */
export function SessionStatusPage({ url, folderSessionId }: { url: string; folderSessionId: string }) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [loaded, setLoaded] = useState(false);
  const { holding } = useSkeletonHold(!loaded);

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
      {holding && <div className="absolute inset-0 bg-surface-primary">
        <LoadingStatus label="Loading the status page" />
        <StatusPageSkeleton />
      </div>}
    </div>
  );
}

/** The status page's own layout (status-page/render.mjs): eyebrow and title, the state bar, then a section of cards. */
function StatusPageSkeleton() {
  return (
    <Skeleton className="mx-auto flex max-w-[860px] flex-col p-[18px]">
      <Bone className="h-2.5 w-24" />
      <Bone className="mt-2 h-5 w-2/3" />
      <div className="mt-3 flex gap-2">
        {[0, 1, 2].map(chip => <Bone key={chip} className="h-7 w-24 rounded-[10px]" />)}
      </div>
      <div className="mt-3 h-9 rounded-[10px] border border-border-primary p-2.5"><Bone className="h-3.5 w-1/3" /></div>
      <Bone className="mt-6 h-2.5 w-20" />
      {[0, 1, 2].map(card => (
        <div key={card} className="mt-2 flex flex-col gap-2 rounded-lg border border-border-primary px-4 py-3">
          <Bone className="h-3.5 w-1/2" />
          <Bone className="h-3 w-5/6" />
        </div>
      ))}
    </Skeleton>
  );
}
