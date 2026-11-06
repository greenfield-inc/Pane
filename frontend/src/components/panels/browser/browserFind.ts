/**
 * Pane's find for browser tabs: drives the <webview>'s built-in find in page
 * (Chromium highlights every match and the current one) and reports
 * "N of M" from its found-in-page events.
 */
import type { FindAdapter, FindMode, FindResult } from '../../find/findController';

/** The parts of Electron's WebviewTag this adapter uses. */
export interface FindableWebview {
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  focus(): void;
}

interface FoundInPageResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface BrowserFindDeps {
  getWebview(): FindableWebview | null;
  /** The page can take find requests (its dom-ready has fired). */
  isReady(): boolean;
  /** False while the tab shows no page (the Ports list). */
  hasPage(): boolean;
  report(result: FindResult): void;
  /** findInPage moves keyboard focus into the page; these keep it in the bar. */
  findInputHasFocus(): boolean;
  focusFindInput(): void;
}

export interface BrowserFindAdapter extends FindAdapter {
  handleFoundInPage(result: FoundInPageResult): void;
}

const NO_MATCHES: FindResult = { current: 0, total: 0 };

export function createBrowserFindAdapter(deps: BrowserFindDeps): BrowserFindAdapter {
  let latestRequestId: number | null = null;
  let query = '';
  let keepFocusInBar = false;

  const request = (text: string, options: { forward?: boolean; findNext: boolean }): FindResult | void => {
    const webview = deps.getWebview();
    if (!webview || !deps.isReady()) {
      // Searched again once the page is ready (BrowserPanel re-runs open searches on load).
      latestRequestId = null;
      return NO_MATCHES;
    }
    keepFocusInBar = deps.findInputHasFocus();
    try {
      latestRequestId = webview.findInPage(text, { ...options, matchCase: false });
    } catch {
      // A guest that is tearing down or not attached yet: nothing to search.
      latestRequestId = null;
      return NO_MATCHES;
    }
    if (keepFocusInBar) deps.focusFindInput();
    return undefined;
  };

  return {
    mode: (): FindMode => (deps.hasPage() ? 'text' : 'none'),
    search(text) {
      query = text;
      // A repeated new session on the same text would advance the current
      // match (a page load re-running the search), so end the old one first.
      if (latestRequestId !== null) {
        try {
          deps.getWebview()?.stopFindInPage('clearSelection');
        } catch {
          // The guest went away; the request below reports 0 of 0.
        }
      }
      // findNext: true starts a new find session (Electron's naming).
      return request(text, { findNext: true, forward: true });
    },
    step(direction) {
      if (!query) return NO_MATCHES;
      return request(query, { findNext: false, forward: direction === 'next' });
    },
    clear() {
      query = '';
      latestRequestId = null;
      try {
        deps.getWebview()?.stopFindInPage('clearSelection');
      } catch {
        // Nothing highlighted in a guest that is not attached.
      }
    },
    restoreFocus() {
      deps.getWebview()?.focus();
    },
    handleFoundInPage(result) {
      if (latestRequestId === null || result.requestId !== latestRequestId) return;
      if (keepFocusInBar && !deps.findInputHasFocus()) deps.focusFindInput();
      if (!result.finalUpdate) return;
      deps.report({ current: result.matches > 0 ? result.activeMatchOrdinal : 0, total: result.matches });
    },
  };
}
