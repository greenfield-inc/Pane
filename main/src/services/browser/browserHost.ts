import { app, BrowserWindow, session, webContents, type WebContents } from 'electron';
import { hasHeadlessDaemonLaunchArg } from '../../utils/runtimeMode';
import { SHARED_BROWSER_PARTITION } from '../../../../shared/constants/browserPartitions';
import { BROWSER_TAB_NOTICE_CHANNEL, type BrowserTabNotice } from '../../../../shared/types/browser';
import path from 'path';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { hardenWebviewPreferences } from '../webviewPreferences';
import type { BrowserPanelState } from '../../../../shared/types/panels';
import { getPaneWebviewContextMap } from '../../core/runtime';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { BrowserHost } from '../../ipc/browser';
import os from 'os';
import { mkdtemp, rm } from 'fs/promises';
import { paneScratchDirectory } from '../paneScratch';
import { panelManager } from '../panelManager';
import { routeWebviewPopups, type PopupTabRequest } from '../webviewPopups';

/** The renderer hears where an agent clicked, to draw its cursor on the tab. */
const BROWSER_AGENT_CURSOR_EVENT = 'browser-panel:agent-cursor';
/** The renderer hears which browser tabs to keep alive while hidden (agents hold them or screens watch them). */
const BROWSER_HELD_EVENT = 'browser-panel:held';
/** A call runs on a tab, so its page paints while hidden. */
const BROWSER_BUSY_EVENT = 'browser-panel:busy';

/** Browser tabs as this computer's main process has them: the panel store and the pages its window registered. */
export function electronBrowserHost(getMainWindow: () => BrowserWindow | null, commandRegistry: PaneCommandRegistry, sessions: Pick<NodeJS.EventEmitter, 'on'>): BrowserHost {
  popupHost = { getMainWindow, commandRegistry };
  // A sign-in popup's tab closed: its page goes with it.
  panelManager.onPanelDeleted(panelId => {
    const popup = popupPages.get(panelId);
    popupPages.delete(panelId);
    popupOpeners.delete(panelId);
    if (popup && !popup.isDestroyed()) popup.destroy();
  });
  return {
    tabs: (paneId) => panelManager.getPanelsBySessionAndType(paneId, 'browser'),
    tab: (panelId) => panelManager.getPanel(panelId),
    open: (paneId, url, callerPanelId) => {
      const customState: BrowserPanelState = { currentUrl: url, agentUse: 'used' };
      return panelManager.createPanel({
        sessionId: paneId,
        type: 'browser',
        title: new URL(url).host || url,
        initialState: { customState },
        metadata: { openPlacement: 'split', openedBy: callerPanelId ? { source: 'agent', panelId: callerPanelId } : { source: 'agent' } },
        // Brings the tab forward on clients showing this Pane; never raises or focuses the window.
        activate: true,
        announceActivation: true,
      });
    },
    close: async (tab) => {
      const deleted = decodeBoundary(await commandRegistry.invoke('panels:delete', [tab.id]), boundary.object({ success: boundary.boolean, error: boundary.optional(boundary.string) }));
      if (!deleted.success) throw new Error(deleted.error ?? 'Pane could not close the tab.');
    },
    update: async (tab, state) => {
      const current = panelManager.getPanel(tab.id) ?? tab;
      await panelManager.updatePanel(tab.id, { state: { ...current.state, customState: state } });
    },
    page: (panelId) => newestPage(panelId),
    sizeHidden: (panelId, size) => {
      const window = headlessPages.get(panelId) ?? popupPages.get(panelId);
      if (window && !window.isDestroyed()) window.setContentSize(size?.width ?? HIDDEN_PAGE.width, size?.height ?? HIDDEN_PAGE.height);
    },
    hasWindow: () => getMainWindow() !== null,
    shotsDirectory: async (paneId) => path.join(await paneScratchDirectory(paneId) ?? os.tmpdir(), 'browser-screenshots'),
    showCursor: (panelId, x, y) => getMainWindow()?.webContents.send(BROWSER_AGENT_CURSOR_EVENT, { panelId, x, y }),
    name: () => os.hostname().replace(/\.local$/i, ''),
    uploadsFor: async (page) => {
      const folder = await mkdtemp(path.join(os.tmpdir(), 'pane-browser-upload-'));
      // The page reads a chosen file when its form submits, so the copy stays until the page goes.
      page.once('destroyed', () => { void rm(folder, { recursive: true, force: true }); });
      return folder;
    },
    setBusy: (panelId, busy) => getMainWindow()?.webContents.send(BROWSER_BUSY_EVENT, { panelId, busy }),
    onGone: (listener) => {
      panelManager.onPanelDeleted(() => listener());
      sessions.on('session-deleted', () => listener());
    },
    setHeld: (tabIds, painting) => {
      remotelyWatched = new Set(painting);
      const window = getMainWindow();
      if (!window) {
        holdHeadless(tabIds);
        return;
      }
      const paint = new Set(painting);
      // While another device streams a tab, the window keeps painting even when minimized or covered.
      window.webContents.setBackgroundThrottling(paint.size === 0);
      window.webContents.send(BROWSER_HELD_EVENT, { tabs: tabIds.map(panelId => ({ panelId, sessionId: panelManager.getPanel(panelId)?.sessionId, painting: paint.has(panelId) })) });
      // The window is back: its tabs hold the pages now, so the hidden windows go.
      holdHeadless([]);
    },
    onDownload: (listener) => {
      void app.whenReady().then(() => {
        session.fromPartition(SHARED_BROWSER_PARTITION).on('will-download', (_event, item, contents) => listener({
          pageId: contents.id,
          tabId: getPaneWebviewContextMap().get(contents.id)?.panelId,
          filename: item.getFilename(),
          saveAs: (file) => item.setSavePath(file),
          finished: new Promise(resolve => item.once('done', (_done, state) => resolve(state === 'completed'))),
        }));
      });
    },
    personDownloads: () => app.getPath('downloads'),
    agentDownloads: async (paneId) => path.join(await paneScratchDirectory(paneId) ?? os.tmpdir(), 'browser-downloads'),
    onSignInRefused: (listener) => {
      signInListeners.add(listener);
    },
    showLogin: (panelId, login) => {
      const notice: BrowserTabNotice = { kind: 'login', ...login };
      getMainWindow()?.webContents.send(BROWSER_TAB_NOTICE_CHANNEL, { panelId, notice });
    },
    openerTab: (panelId) => popupOpeners.get(panelId),
    showDownload: (panelId, file, agent) => {
      const notice: BrowserTabNotice = { kind: 'downloaded', name: path.basename(file), file };
      if (agent) notice.agent = agent;
      getMainWindow()?.webContents.send(BROWSER_TAB_NOTICE_CHANNEL, { panelId, notice });
    },
  };
}

/** A remounted tab registers a new page id and the old ones stay mapped, so the newest live one wins. */
function newestPage(panelId: string): Electron.WebContents | undefined {
  let newest: Electron.WebContents | undefined;
  for (const [id, context] of getPaneWebviewContextMap()) {
    if (context.panelId !== panelId) continue;
    const contents = webContents.fromId(id);
    // Only a browser tab's own page (a tab's webview, or the hidden window holding it on a host with
    // no window): never another kind of WebContents that reused a mapped id.
    if (!contents || contents.isDestroyed()) continue;
    if (contents.getType() !== 'webview' && headlessPages.get(panelId)?.webContents !== contents && popupPages.get(panelId)?.webContents !== contents) continue;
    if (!newest || contents.id > newest.id) newest = contents;
  }
  return newest;
}

/** A hidden page's size while no screen on another device controls it. */
const HIDDEN_PAGE = { width: 1280, height: 800 };

/** A host with no window keeps each held tab's page in a hidden window, in the shared sign-in store. */
const headlessPages = new Map<string, BrowserWindow>();

/** Sign-in popups that became tabs, by tab: each one's hidden window, still linked to its opener. */
const popupPages = new Map<string, BrowserWindow>();

/** The tab each sign-in popup's tab came from, for as long as both are linked. */
const popupOpeners = new Map<string, string>();

/** Tabs another device watches now (setHeld's `painting`): their sign-in popups become tabs. */
let remotelyWatched = new Set<string>();

/** What popup tabs need from the host, once electronBrowserHost has run. */
let popupHost: { getMainWindow: () => BrowserWindow | null; commandRegistry: PaneCommandRegistry } | undefined;

type SignInListener = (panelId: string, signIn: { site: string; url: string }) => void;
const signInListeners = new Set<SignInListener>();

/**
 * A tab stopped a sign-in that refuses to run inside apps: the tab in this window says so, and so
 * does every screen streaming it (browser:view), each offering its own browser.
 */
export function refuseSignIn(panelId: string, site: string, url: string): void {
  // The line offers a web page in another browser; a tab on any other page stops without one.
  if (!/^https?:\/\//i.test(url)) return;
  const notice: BrowserTabNotice = { kind: 'sign-in', site, url };
  popupHost?.getMainWindow()?.webContents.send(BROWSER_TAB_NOTICE_CHANNEL, { panelId, notice });
  for (const listener of signInListeners) listener(panelId, { site, url });
}

/**
 * How a sign-in popup from `opener` opens: as a tab beside it when nobody would see a window on this
 * computer (another device watches the opener, or there is no window), else undefined.
 */
export function popupTabFor(opener: { panelId: string }): ((request: PopupTabRequest) => WebContents) | undefined {
  if (!popupHost) return undefined;
  return remotelyWatched.has(opener.panelId) || !popupHost.getMainWindow() ? openPopupTab : undefined;
}

/**
 * Opens a sign-in popup as a tab beside its opener. Its page is the one Chromium made for the popup,
 * in a hidden window here, so it keeps its opener and can report the sign-in back; every screen
 * streams it. The tab closes when the popup closes itself or its opener goes.
 */
function openPopupTab({ url, options, opener, openerUrl }: PopupTabRequest): WebContents {
  const webPreferences = { ...options.webPreferences };
  hardenWebviewPreferences(webPreferences);
  const window = new BrowserWindow({
    ...options,
    show: false,
    useContentSize: true,
    width: options.width ?? HIDDEN_PAGE.width,
    height: options.height ?? HIDDEN_PAGE.height,
    paintWhenInitiallyHidden: true,
    webPreferences,
  });
  const page = window.webContents;
  let tabId: string | undefined;
  const closeTab = () => {
    if (!tabId) return;
    popupPages.delete(tabId);
    // Every screen goes back to the opener, where the sign-in reported back (or its line shows).
    void popupHost?.commandRegistry.invoke('panels:delete', [tabId])
      .then(() => panelManager.getPanel(opener.panelId) && panelManager.setActivePanel(opener.sessionId, opener.panelId))
      .catch(() => undefined);
  };
  window.once('closed', closeTab);
  routeHiddenPage(page, {
    // A sign-in the popup reaches that refuses apps closes the popup; its opener says so, offering
    // the opener's page, since the popup's own page needs its opener.
    refuseSignIn: ({ site }) => {
      refuseSignIn(opener.panelId, site, openerUrl);
      if (!window.isDestroyed()) window.close();
    },
  });
  let title = 'Sign in';
  try { title = new URL(url).host || title; } catch { /* about:blank until the sign-in script navigates it */ }
  const customState: BrowserPanelState = { currentUrl: url, signInPopup: true };
  void panelManager.createPanel({
    sessionId: opener.sessionId,
    type: 'browser',
    title,
    initialState: { customState },
    metadata: { openPlacement: 'split' },
    // Brings the tab forward on every screen showing this Pane, where the person signs in.
    activate: true,
    announceActivation: true,
  }).then(panel => {
    tabId = panel.id;
    if (window.isDestroyed()) {
      closeTab();
      return;
    }
    popupPages.set(panel.id, window);
    popupOpeners.set(panel.id, opener.panelId);
    getPaneWebviewContextMap().set(page.id, { panelId: panel.id, sessionId: opener.sessionId });
    rememberUrl(page, panel.id);
  }).catch(error => {
    console.warn('[browser] A sign-in popup could not open as a tab:', error);
    if (!window.isDestroyed()) window.destroy();
  });
  return page;
}

/** The tab remembers where its page went, as a tab in a window does, so waking it returns there. */
function rememberUrl(page: WebContents, panelId: string): void {
  page.on('did-navigate', (_event, pageUrl) => {
    const current = panelManager.getPanel(panelId);
    if (!current) return;
    void panelManager.updatePanel(panelId, { state: { ...current.state, customState: { ...decodeOptionalBoundary(current.state.customState, boundary.jsonObject), currentUrl: pageUrl } } }).catch(() => undefined);
  });
}

/**
 * A hidden page's popups and navigations. Nobody sits at it, so it hands nothing to this computer:
 * no system browser, no app (zoommtg:, slack:), no pane:// link. Its sign-in popups and new-tab
 * links open as tabs beside it, which the screens watching it stream.
 */
function routeHiddenPage(page: WebContents, overrides: { refuseSignIn?: (request: { url: string; site: string; panelId: string | undefined }) => void } = {}): void {
  routeWebviewPopups(page, {
    contextOf: id => getPaneWebviewContextMap().get(id),
    openBrowserTab: ({ url, sourceSessionId }) => {
      const customState: BrowserPanelState = { currentUrl: url, isPopup: true };
      void panelManager.createPanel({ sessionId: sourceSessionId, type: 'browser', title: hostOf(url), initialState: { customState }, metadata: { openPlacement: 'split' }, activate: true, announceActivation: true })
        .catch(error => console.warn('[browser] A hidden page\'s new tab did not open:', error));
    },
    openExternal: url => console.warn(`[browser] A hidden page asked to open ${url} outside Pane; nobody is here to see it.`),
    openPaneLink: () => console.warn('[browser] Ignored a pane:// link from a hidden page'),
    offerApp: () => undefined,
    refuseSignIn: overrides.refuseSignIn ?? (({ url, site, panelId }) => { if (panelId) refuseSignIn(panelId, site, url); }),
    popupTab: () => openPopupTab,
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

let headlessPartitionGuarded = false;

/**
 * Nobody sits at a hidden page: its popups open as tabs (routeHiddenPage), and the OS hands it no
 * app, where a tab in a window would ask the person first. A window's tabs set the partition's own rules.
 */
function guardHeadlessPage(contents: Electron.WebContents): void {
  routeHiddenPage(contents);
  if (headlessPartitionGuarded || !hasHeadlessDaemonLaunchArg()) return;
  headlessPartitionGuarded = true;
  session.fromPartition(SHARED_BROWSER_PARTITION).setPermissionRequestHandler((_contents, permission, callback) => callback(permission !== 'openExternal'));
}

function holdHeadless(tabIds: readonly string[]): void {
  const wanted = new Set(tabIds);
  for (const [panelId, window] of headlessPages) {
    if (wanted.has(panelId)) continue;
    headlessPages.delete(panelId);
    if (!window.isDestroyed()) window.destroy();
  }
  for (const panelId of wanted) {
    // A sign-in popup's tab already has its page, linked to its opener.
    if (headlessPages.has(panelId) || popupPages.has(panelId)) continue;
    const panel = panelManager.getPanel(panelId);
    const url = decodeOptionalBoundary(panel?.state.customState, boundary.object({ currentUrl: boundary.optional(boundary.string) }))?.currentUrl;
    if (!panel || !url) continue;
    const webPreferences = { partition: SHARED_BROWSER_PARTITION };
    hardenWebviewPreferences(webPreferences);
    const size = decodeOptionalBoundary(panel.state.customState, boundary.object({ pageSize: boundary.optional(boundary.object({ width: boundary.number, height: boundary.number })) }))?.pageSize ?? HIDDEN_PAGE;
    const window = new BrowserWindow({ show: false, useContentSize: true, width: size.width, height: size.height, paintWhenInitiallyHidden: true, webPreferences });
    guardHeadlessPage(window.webContents);
    headlessPages.set(panelId, window);
    getPaneWebviewContextMap().set(window.webContents.id, { panelId, sessionId: panel.sessionId });
    window.webContents.once('destroyed', () => { if (headlessPages.get(panelId) === window) headlessPages.delete(panelId); });
    rememberUrl(window.webContents, panelId);
    void window.loadURL(url).catch(error => console.warn(`[browser] A held tab's hidden page did not load ${url}:`, error));
  }
}
