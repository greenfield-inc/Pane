import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Globe, ArrowLeft, ArrowRight, RotateCw, Loader2 } from 'lucide-react';
import type { ToolPanel, BrowserPanelState } from '../../../../../shared/types/panels';
import { cn } from '../../../utils/cn';
import { panelApi } from '../../../services/panelApi';
import { usePanelStore } from '../../../stores/panelStore';
import { resolveBrowserNavigation } from '../../../services/browserPanelNavigation';
import { useSessionStore } from '../../../stores/sessionStore';
import { useResizable } from '../../../hooks/useResizable';
import { normalizeUrl } from './browserUrl';

interface BrowserPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({ panel, isActive }) => {
  const initRef = useRef(false);
  const [url, setUrl] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
  const browserStateFromPanel = panel.state.customState as BrowserPanelState | undefined;
  const currentUrlFromPanelState = browserStateFromPanel?.currentUrl;
  const navigationNonceFromPanelState = browserStateFromPanel?.navigationNonce;
  const lastNavigationNonceRef = useRef<number | undefined>(navigationNonceFromPanelState);

  const webviewRef = useRef<Electron.WebviewTag>(null);
  const devToolsPlaceholderRef = useRef<HTMLDivElement>(null);
  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panelIdRef = useRef(panel.id);

  // Track the page webContentsId for DevTools IPC calls
  const pageWcIdRef = useRef<number | null>(null);
  // Track whether we've already created the WebContentsView for the current open session
  const devToolsInitializedRef = useRef(false);

  const addPanel = usePanelStore((state) => state.addPanel);
  const setActivePanelInStore = usePanelStore((state) => state.setActivePanel);

  // Look up the project ID for this session so all browser panels in the same project
  // share a single partition (cookies, localStorage, auth state persist across sessions).
  const projectId = useSessionStore((state) => {
    const session = state.sessions.find(s => s.id === panel.sessionId);
    return session?.projectId;
  });

  // Resizable DevTools column
  const { width: devToolsWidth, startResize: startDevToolsResize } = useResizable({
    defaultWidth: 400,
    minWidth: 200,
    maxWidth: 800,
    storageKey: 'pane-browser-devtools-width',
    side: 'right',
  });

  // Initialize from persisted state only on mount
  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
      const savedState = panel.state.customState as BrowserPanelState | undefined;
      if (savedState?.currentUrl) {
        setUrl(savedState.currentUrl);
        setInputUrl(savedState.currentUrl);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  // Cleanup persist timeout on unmount
  useEffect(() => {
    return () => clearTimeout(persistTimeoutRef.current);
  }, []);

  // Close DevTools WebContentsView when component unmounts
  useEffect(() => {
    return () => {
      if (pageWcIdRef.current) {
        window.electronAPI?.invoke('browser-panel:close-devtools', pageWcIdRef.current);
      }
    };
  }, []);

  const persistState = useCallback((newUrl: string) => {
    clearTimeout(persistTimeoutRef.current);
    persistTimeoutRef.current = setTimeout(() => {
      window.electron?.invoke('panels:update', panelIdRef.current, {
        state: { customState: { currentUrl: newUrl } }
      });
    }, 2000);
  }, []);

  const navigateTo = useCallback((rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl);
    let parsed: URL | null = null;
    try {
      parsed = new URL(normalized);
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:', 'file:'].includes(parsed.protocol)) {
      setUrlError('Enter a valid http, https, or file URL');
      return;
    }
    setUrlError('');
    setIsLoading(true);
    setUrl(normalized);
    setInputUrl(normalized);
    persistState(normalized);
  }, [persistState]);

  // Single navigation trigger for requests from other surfaces (terminal links,
  // selection popover, HTML preview): they write panel state through
  // openUrlInSessionBrowser, and a fresh nonce for the same URL means reload.
  useEffect(() => {
    const decision = resolveBrowserNavigation(
      { url, nonce: lastNavigationNonceRef.current },
      { currentUrl: currentUrlFromPanelState, nonce: navigationNonceFromPanelState },
    );
    lastNavigationNonceRef.current = navigationNonceFromPanelState;
    if (decision === 'navigate' && currentUrlFromPanelState) navigateTo(currentUrlFromPanelState);
    else if (decision === 'reload') webviewRef.current?.reload();
  }, [currentUrlFromPanelState, navigationNonceFromPanelState, navigateTo, url]);

  const handleBack = () => {
    webviewRef.current?.goBack();
  };

  const handleForward = () => {
    webviewRef.current?.goForward();
  };

  const handleRefresh = () => {
    webviewRef.current?.reload();
  };

  const handleToggleDevTools = useCallback(async () => {
    if (!pageWcIdRef.current) return;
    if (devToolsOpen) {
      await window.electronAPI?.invoke('browser-panel:close-devtools', pageWcIdRef.current);
      devToolsInitializedRef.current = false;
      setDevToolsOpen(false);
    } else {
      setDevToolsOpen(true);
      // Bounds will be sent in the useEffect below after the placeholder renders
    }
  }, [devToolsOpen]);

  // Send devtools placeholder bounds to main process when DevTools opens or the column resizes
  useEffect(() => {
    if (!devToolsOpen) {
      devToolsInitializedRef.current = false;
      return;
    }

    const el = devToolsPlaceholderRef.current;
    if (!el || !pageWcIdRef.current) return;

    const rect = el.getBoundingClientRect();
    const scaleFactor = window.devicePixelRatio || 1;
    const bounds = {
      x: Math.round(rect.x * scaleFactor),
      y: Math.round(rect.y * scaleFactor),
      width: Math.round(rect.width * scaleFactor),
      height: Math.round(rect.height * scaleFactor),
    };

    if (!devToolsInitializedRef.current) {
      // First open — create the WebContentsView
      devToolsInitializedRef.current = true;
      window.electronAPI?.invoke('browser-panel:open-devtools-inline', pageWcIdRef.current, bounds);
    } else {
      // Resize — just reposition the existing view
      window.electronAPI?.invoke('browser-panel:resize-devtools', pageWcIdRef.current, bounds);
    }
  }, [devToolsOpen, devToolsWidth]);

  // Update DevTools overlay bounds whenever the placeholder div changes size.
  // ResizeObserver catches ALL layout changes — window resize, bottom pane expanding,
  // sidebar toggling, etc. — not just window resize events.
  useEffect(() => {
    if (!devToolsOpen || !devToolsInitializedRef.current) return;
    const el = devToolsPlaceholderRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      if (!pageWcIdRef.current) return;
      const rect = el.getBoundingClientRect();
      const scaleFactor = window.devicePixelRatio || 1;
      const bounds = {
        x: Math.round(rect.x * scaleFactor),
        y: Math.round(rect.y * scaleFactor),
        width: Math.round(rect.width * scaleFactor),
        height: Math.round(rect.height * scaleFactor),
      };
      window.electronAPI?.invoke('browser-panel:resize-devtools', pageWcIdRef.current, bounds);
    });
    observer.observe(el);
    // Also observe the parent container — when the detail panel collapses/expands,
    // the parent's width changes (shifting the placeholder's X position) but the
    // placeholder's own size stays the same, so we need both.
    if (el.parentElement) observer.observe(el.parentElement);
    return () => observer.disconnect();
  }, [devToolsOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigateTo(inputUrl);
  };

  // Wire webview events when the webview element is mounted.
  // Depends on `url` because the <webview> is only rendered when url is non-empty,
  // so the ref is null until the first URL is set.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      const wcId = webview.getWebContentsId();
      pageWcIdRef.current = wcId;
      window.electronAPI?.invoke('browser-panel:register-webview', wcId, panel.id, panel.sessionId);
    };

    const onDidNavigate = () => {
      const currentUrl = webview.getURL();
      if (currentUrl && currentUrl !== 'about:blank') {
        setInputUrl(currentUrl);
        persistState(currentUrl);
      }
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
      setIsLoading(false);
    };

    const onDidStartLoading = () => setIsLoading(true);
    const onDidStopLoading = () => {
      setIsLoading(false);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };

    webview.addEventListener('dom-ready', onDomReady);
    webview.addEventListener('did-navigate', onDidNavigate);
    webview.addEventListener('did-navigate-in-page', onDidNavigate);
    webview.addEventListener('did-start-loading', onDidStartLoading);
    webview.addEventListener('did-stop-loading', onDidStopLoading);

    return () => {
      webview.removeEventListener('dom-ready', onDomReady);
      webview.removeEventListener('did-navigate', onDidNavigate);
      webview.removeEventListener('did-navigate-in-page', onDidNavigate);
      webview.removeEventListener('did-start-loading', onDidStartLoading);
      webview.removeEventListener('did-stop-loading', onDidStopLoading);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when url becomes non-empty (webview mounts); persistState reads from refs
  }, [panel.id, url]);

  // Listen for popup-requested events from the main process.
  // Uses stopImmediatePropagation so only the originating browser panel handles the event,
  // preventing duplicate popup panels when multiple browser panels exist in a session.
  useEffect(() => {
    const handler = (e: Event) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      const { url: popupUrl, sourceSessionId, sourcePanelId } = (e as CustomEvent<{ url: string; sourceSessionId: string; sourcePanelId: string }>).detail;
      if (sourceSessionId !== panel.sessionId || sourcePanelId !== panel.id) return;
      e.stopImmediatePropagation();
      let title = 'Popup';
      try { title = new URL(popupUrl).hostname || 'Popup'; } catch { /* malformed URL */ }
      panelApi.createPanel({
        sessionId: panel.sessionId,
        type: 'browser',
        title,
        initialState: { customState: { currentUrl: popupUrl, isPopup: true } }
      }).then(async (newPanel) => {
        addPanel(newPanel);
        setActivePanelInStore(panel.sessionId, newPanel.id);
        await panelApi.setActivePanel(panel.sessionId, newPanel.id);
      }).catch((err) => {
        console.error('[BrowserPanel] Failed to create popup panel:', err);
      });
    };
    window.addEventListener('browser-panel:popup-requested', handler);
    return () => window.removeEventListener('browser-panel:popup-requested', handler);
  }, [panel.id, panel.sessionId, addPanel, setActivePanelInStore]);

  // Hide/show DevTools overlay when switching between panel tabs.
  // Close the WebContentsView when inactive so it doesn't cover other panels,
  // and re-open it when this panel becomes active again.
  useEffect(() => {
    if (!devToolsOpen || !pageWcIdRef.current) return;
    if (!isActive) {
      // Panel became inactive — hide the overlay
      window.electronAPI?.invoke('browser-panel:close-devtools', pageWcIdRef.current);
      devToolsInitializedRef.current = false;
    } else if (!devToolsInitializedRef.current) {
      // Panel became active again — re-open devtools
      const el = devToolsPlaceholderRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const scaleFactor = window.devicePixelRatio || 1;
        const bounds = {
          x: Math.round(rect.x * scaleFactor),
          y: Math.round(rect.y * scaleFactor),
          width: Math.round(rect.width * scaleFactor),
          height: Math.round(rect.height * scaleFactor),
        };
        devToolsInitializedRef.current = true;
        window.electronAPI?.invoke('browser-panel:open-devtools-inline', pageWcIdRef.current, bounds);
      }
    }
  }, [isActive, devToolsOpen]);

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Browser chrome */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border-primary bg-bg-chrome flex-shrink-0">
        <button
          onClick={handleBack}
          disabled={!canGoBack}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !canGoBack && 'opacity-30 cursor-not-allowed'
          )}
          title="Back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
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
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleRefresh}
          disabled={!url}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !url && 'opacity-30 cursor-not-allowed'
          )}
          title="Refresh"
        >
          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCw className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={handleToggleDevTools}
          disabled={!url}
          className={cn(
            'p-1 rounded hover:bg-surface-hover transition-colors',
            !url && 'opacity-30 cursor-not-allowed',
            devToolsOpen && 'bg-surface-hover text-text-primary'
          )}
          title="Toggle DevTools"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </button>
        <form onSubmit={handleSubmit} className="flex-1 min-w-0">
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => { setInputUrl(e.target.value); setUrlError(''); }}
            placeholder="Enter a URL (e.g. localhost:3000)"
            className={cn(
              'w-full px-2.5 py-1 text-sm rounded bg-bg-primary border border-border-primary',
              'text-text-primary placeholder-text-tertiary',
              'focus:outline-none focus:border-border-focus',
              urlError && 'border-red-500'
            )}
          />
        </form>
      </div>

      {/* Error feedback */}
      {urlError && (
        <div className="text-xs text-red-500 px-2 py-1 bg-bg-primary border-b border-border-primary">
          {urlError}
        </div>
      )}

      {/* Content area */}
      {!url ? (
        <div className="flex-1 flex flex-col items-center justify-center text-text-secondary p-8">
          <Globe className="w-12 h-12 mb-4 opacity-20" />
          <p className="text-sm">No URL loaded</p>
          <p className="text-xs text-text-tertiary mt-1">
            Enter a URL above or select one from terminal output
          </p>
        </div>
      ) : (
        <div className="flex-1 flex flex-row min-h-0">
          {/* Page webview */}
          <webview
            ref={webviewRef}
            src={url}
            partition={`persist:project-${projectId ?? panel.sessionId}`}
            allowpopups
            className="flex-1 border-0"
            style={{ display: 'inline-flex' }}
          />

          {/* DevTools resize handle + placeholder div (overlaid by WebContentsView from main process) */}
          {devToolsOpen && (
            <>
              <div
                className="w-1 cursor-col-resize flex-shrink-0 bg-border-primary hover:bg-border-focus transition-colors"
                onMouseDown={startDevToolsResize}
              />
              <div
                ref={devToolsPlaceholderRef}
                className="flex-shrink-0 bg-bg-primary"
                style={{ width: devToolsWidth }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default BrowserPanel;
