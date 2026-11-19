import type { BrowserWindow, WebContents } from 'electron';
import { appLinkOrNull, externalUrlOrNull } from '../utils/externalUrl';

interface WebviewPopupRouting {
  /** The panel a webview belongs to, once the renderer has registered it. */
  contextOf(webContentsId: number): { panelId: string; sessionId: string } | undefined;
  /** Opens a regular link as a new browser tab next to its source panel. */
  openBrowserTab(request: { url: string; sourceSessionId: string; sourcePanelId: string }): void;
  openExternal(url: string): void;
  /** Opens a Pane, Session or repository the way an OS-level pane:// link does. */
  openPaneLink(url: string): void;
  /** The page asked for an app link (zoommtg:, slack:): the tab asks the person before the OS opens it. */
  offerApp(request: { url: string; panelId: string }): void;
  /** Opens a sign-in that fails in an embedded browser in the system browser, and the tab says so. */
  sendOut(request: { url: string; site: string; panelId: string | undefined }): void;
}

/**
 * Sites whose sign-in refuses an embedded browser, by host, with the name the tab's notice uses.
 * Their pages open in the system browser instead (docs/BROWSER_AGENTS.md).
 */
const SYSTEM_BROWSER_SITES: ReadonlyMap<string, string> = new Map([
  // Google refuses sign-in in embedded browsers ("This browser or app may not be secure", disallowed_useragent).
  ['accounts.google.com', 'Google sign-in'],
]);

/** The name of the sign-in `url` belongs to when it only works in the system browser. */
function systemBrowserSite(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? SYSTEM_BROWSER_SITES.get(parsed.hostname) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A pane:// link opens a Pane, Session or repository. Only pages loaded from a
 * local file (pages Pane or an agent opened, like Start here) may follow one;
 * a web page can't steer the app.
 */
function followPaneLink(pageUrl: string, url: string, routing: WebviewPopupRouting): boolean {
  if (!url.toLowerCase().startsWith('pane://')) return false;
  if (pageUrl.toLowerCase().startsWith('file:')) routing.openPaneLink(url);
  else console.warn('[BrowserPanel] Ignored a pane:// link from a web page');
  return true;
}

type NavigationEvent = { preventDefault: () => void };

/**
 * Routes a browser tab's window.open calls and navigations. Sign-in popups become real windows in
 * the tab's own store, so they share its logins; other links open as Pane tabs. App links wait for
 * the person's OK, and sign-ins that refuse an embedded browser go to the system browser.
 */
export function routeWebviewPopups(
  wvContents: Pick<WebContents, 'id' | 'getURL' | 'setWindowOpenHandler' | 'on' | 'once'>,
  routing: WebviewPopupRouting,
): void {
  const panelId = () => routing.contextOf(wvContents.id)?.panelId;
  /** Sends a page that only works in the system browser there; true when it did. */
  const leaveFor = (event: NavigationEvent, url: string): boolean => {
    const site = systemBrowserSite(url);
    if (!site) return false;
    event.preventDefault();
    routing.sendOut({ url, site, panelId: panelId() });
    return true;
  };

  wvContents.on('will-navigate', (event, url) => {
    if (followPaneLink(wvContents.getURL(), url, routing)) event.preventDefault();
    else leaveFor(event, url);
  });
  wvContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) leaveFor(event, url);
  });

  wvContents.setWindowOpenHandler(({ url, disposition }) => {
    if (followPaneLink(wvContents.getURL(), url, routing)) return { action: 'deny' };
    if (leaveFor({ preventDefault: () => undefined }, url)) return { action: 'deny' };
    const appLink = appLinkOrNull(url);
    if (appLink !== null) {
      const panel = panelId();
      if (panel) routing.offerApp({ url: appLink, panelId: panel });
      return { action: 'deny' };
    }
    // Pages in a browser tab are untrusted: only web links may leave it. A file: or
    // app-scheme URL would otherwise reach the OS through a popup, tab or openExternal.
    // about:blank stays allowed for popups that a sign-in script navigates after opening.
    if (url !== 'about:blank' && externalUrlOrNull(url) === null) {
      console.warn('[BrowserPanel] Blocked window.open to a non-web URL scheme, wcId:', wvContents.id);
      return { action: 'deny' };
    }

    // Auth popups (Firebase signInWithPopup, OAuth providers, etc.) use window.open()
    // with explicit features (width, height, toolbar=no), which Chromium reports as
    // disposition 'new-window'. Let these open as real BrowserWindows so the
    // postMessage channel between popup and opener remains intact.
    if (disposition === 'new-window') {
      if (!routing.contextOf(wvContents.id)) {
        console.warn('[BrowserPanel] Auth popup allowed for unregistered webview (pre-dom-ready), wcId:', wvContents.id);
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    }

    // Regular navigations (target="_blank" links, etc.) → open as new browser panel tab
    const ctx = routing.contextOf(wvContents.id);
    if (ctx) {
      routing.openBrowserTab({ url, sourceSessionId: ctx.sessionId, sourcePanelId: ctx.panelId });
    } else {
      // Context not yet registered (popup fired before dom-ready).
      // Fall back to opening in the system browser so the popup isn't silently lost.
      routing.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Track and manage auth popup windows created by { action: 'allow' }.
  // Clean up when the parent webview is destroyed so popups don't orphan.
  wvContents.on('did-create-window', (popupWindow: BrowserWindow) => {
    // A sign-in popup that reaches a site refusing embedded browsers closes, and the sign-in goes
    // to the system browser instead.
    const leavePopup = (event: NavigationEvent, url: string) => {
      if (leaveFor(event, url) && !popupWindow.isDestroyed()) popupWindow.close();
    };
    popupWindow.webContents.on('will-navigate', leavePopup);
    popupWindow.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) leavePopup(event, url);
    });
    // If the parent webview is destroyed (e.g., panel closed), close the popup too.
    // This is a one-shot listener; safe even if the popup closes first because
    // popupWindow.isDestroyed() is checked before calling close().
    wvContents.once('destroyed', () => {
      if (!popupWindow.isDestroyed()) {
        popupWindow.close();
      }
    });
  });
}
