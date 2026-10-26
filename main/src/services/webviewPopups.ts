import type { WebContents } from 'electron';
import { externalUrlOrNull } from '../utils/externalUrl';

interface WebviewPopupRouting {
  /** The panel a webview belongs to, once the renderer has registered it. */
  contextOf(webContentsId: number): { panelId: string; sessionId: string } | undefined;
  /** Opens a regular link as a new browser tab next to its source panel. */
  openBrowserTab(request: { url: string; sourceSessionId: string; sourcePanelId: string }): void;
  openExternal(url: string): void;
}

/**
 * Routes a browser tab's window.open calls. Sign-in popups become real windows in
 * the tab's own store, so they share its logins; other links open as Pane tabs.
 */
export function routeWebviewPopups(
  wvContents: Pick<WebContents, 'id' | 'setWindowOpenHandler' | 'on' | 'once'>,
  routing: WebviewPopupRouting,
): void {
  wvContents.setWindowOpenHandler(({ url, disposition }) => {
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
  wvContents.on('did-create-window', (popupWindow) => {
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
