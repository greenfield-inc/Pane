import { useState, useRef, useEffect, useCallback } from 'react';
import { Modal } from './ui/Modal';
import { DOCS_BROWSER_PARTITION } from '../../../shared/constants/browserPartitions';
import { cn } from '../utils/cn';

const DOCS_URL = 'https://runpane.com/docs';
const DOCS_HOSTNAME = 'runpane.com';

interface DocsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DocsDialog({ isOpen, onClose }: DocsDialogProps) {
  const webviewRef = useRef<Electron.WebviewTag>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [currentTitle, setCurrentTitle] = useState('Docs');

  const handleBack = useCallback(() => {
    webviewRef.current?.goBack();
  }, []);

  const handleForward = useCallback(() => {
    webviewRef.current?.goForward();
  }, []);

  const handleRefresh = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  // Wire webview events when mounted
  useEffect(() => {
    if (!isOpen) return;

    const webview = webviewRef.current;
    if (!webview) return;

    const onDidStartLoading = () => setIsLoading(true);
    const onDidStopLoading = () => {
      setIsLoading(false);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    const onDidNavigate = () => {
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
      setIsLoading(false);
    };
    const onPageTitleUpdated = (e: Electron.PageTitleUpdatedEvent) => {
      setCurrentTitle(e.title || 'Docs');
    };

    // Intercept navigation to external sites — open in system browser instead
    const onWillNavigate = (e: Electron.WillNavigateEvent) => {
      try {
        const targetUrl = new URL(e.url);
        if (targetUrl.hostname !== DOCS_HOSTNAME && targetUrl.hostname !== `www.${DOCS_HOSTNAME}`) {
          // External link — block in-webview navigation and open in system browser
          e.preventDefault();
          window.electronAPI?.openExternal(e.url);
        }
      } catch {
        // Malformed URL — ignore
      }
    };

    webview.addEventListener('did-start-loading', onDidStartLoading);
    webview.addEventListener('did-stop-loading', onDidStopLoading);
    webview.addEventListener('did-navigate', onDidNavigate);
    webview.addEventListener('did-navigate-in-page', onDidNavigate);
    webview.addEventListener('page-title-updated', onPageTitleUpdated);
    webview.addEventListener('will-navigate', onWillNavigate);

    return () => {
      webview.removeEventListener('did-start-loading', onDidStartLoading);
      webview.removeEventListener('did-stop-loading', onDidStopLoading);
      webview.removeEventListener('did-navigate', onDidNavigate);
      webview.removeEventListener('did-navigate-in-page', onDidNavigate);
      webview.removeEventListener('page-title-updated', onPageTitleUpdated);
      webview.removeEventListener('will-navigate', onWillNavigate);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <Modal
      ariaLabel="Pane documentation"
      isOpen={isOpen}
      onClose={onClose}
      size="full"
      showCloseButton={false}
      closeOnOverlayClick={false}
      className="h-[90vh]"
    >
      {/* Chrome bar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-primary bg-surface-secondary flex-shrink-0">
        {/* Navigation buttons */}
        <button
          onClick={handleBack}
          disabled={!canGoBack}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !canGoBack && 'opacity-30 cursor-not-allowed'
          )}
          title="Back"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={handleForward}
          disabled={!canGoForward}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !canGoForward && 'opacity-30 cursor-not-allowed'
          )}
          title="Forward"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
        </button>
        <button
          onClick={handleRefresh}
          className="p-1 rounded hover:bg-surface-hover transition-colors"
          title="Refresh"
        >
          {isLoading ? (
            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
            </svg>
          )}
        </button>

        {/* Title */}
        <span className="flex-1 text-sm text-text-secondary text-center truncate px-2">
          {currentTitle}
        </span>

        {/* Close button */}
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-surface-hover transition-colors text-text-tertiary hover:text-text-primary"
          title="Close"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Webview */}
      <div className="flex-1 min-h-0">
        <webview
          ref={webviewRef}
          src={DOCS_URL}
          partition={DOCS_BROWSER_PARTITION}
          allowpopups
          className="w-full h-full border-0"
          style={{ display: 'inline-flex' }}
        />
      </div>
    </Modal>
  );
}
