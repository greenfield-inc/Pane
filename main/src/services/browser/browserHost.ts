import { app, BrowserWindow, session, webContents } from 'electron';
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
import { paneScratchDirectory } from '../paneScratch';
import { panelManager } from '../panelManager';

/** The renderer hears where an agent clicked, to draw its cursor on the tab. */
const BROWSER_AGENT_CURSOR_EVENT = 'browser-panel:agent-cursor';
/** The renderer hears which browser tabs to keep alive while hidden (agents hold them or screens watch them). */
const BROWSER_HELD_EVENT = 'browser-panel:held';
/** A call runs on a tab, so its page paints while hidden. */
const BROWSER_BUSY_EVENT = 'browser-panel:busy';

/** Browser tabs as this computer's main process has them: the panel store and the pages its window registered. */
export function electronBrowserHost(getMainWindow: () => BrowserWindow | null, commandRegistry: PaneCommandRegistry, sessions: Pick<NodeJS.EventEmitter, 'on'>): BrowserHost {
  return {
    tabs: (paneId) => panelManager.getPanelsBySessionAndType(paneId, 'browser'),
    tab: (panelId) => panelManager.getPanel(panelId),
    open: (paneId, url, callerPanelId) => {
      const customState: BrowserPanelState = { currentUrl: url };
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
      const window = headlessPages.get(panelId);
      if (window && !window.isDestroyed()) window.setContentSize(size?.width ?? HIDDEN_PAGE.width, size?.height ?? HIDDEN_PAGE.height);
    },
    hasWindow: () => getMainWindow() !== null,
    shotsDirectory: async (paneId) => path.join(await paneScratchDirectory(paneId) ?? os.tmpdir(), 'browser-screenshots'),
    showCursor: (panelId, x, y) => getMainWindow()?.webContents.send(BROWSER_AGENT_CURSOR_EVENT, { panelId, x, y }),
    setBusy: (panelId, busy) => getMainWindow()?.webContents.send(BROWSER_BUSY_EVENT, { panelId, busy }),
    onGone: (listener) => {
      panelManager.onPanelDeleted(() => listener());
      sessions.on('session-deleted', () => listener());
    },
    setHeld: (tabIds, painting) => {
      const window = getMainWindow();
      if (!window) {
        holdHeadless(tabIds);
        return;
      }
      const paint = new Set(painting);
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
    if (contents.getType() !== 'webview' && headlessPages.get(panelId)?.webContents !== contents) continue;
    if (!newest || contents.id > newest.id) newest = contents;
  }
  return newest;
}

/** A hidden page's size while no screen on another device controls it. */
const HIDDEN_PAGE = { width: 1280, height: 800 };

/** A host with no window keeps each held tab's page in a hidden window, in the shared sign-in store. */
const headlessPages = new Map<string, BrowserWindow>();

let headlessPartitionGuarded = false;

/**
 * Nobody watches a hidden page: it opens no windows, and the OS hands it no app (zoommtg:, slack:),
 * where a tab in a window would ask the person first. A window's tabs set the partition's own rules.
 */
function guardHeadlessPage(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    if (headlessPages.has(panelId)) continue;
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
    // The tab remembers where its page went, as a tab in a window does, so waking it returns there.
    window.webContents.on('did-navigate', (_event, pageUrl) => {
      const current = panelManager.getPanel(panelId);
      if (!current) return;
      void panelManager.updatePanel(panelId, { state: { ...current.state, customState: { ...decodeOptionalBoundary(current.state.customState, boundary.jsonObject), currentUrl: pageUrl } } }).catch(() => undefined);
    });
    void window.loadURL(url).catch(error => console.warn(`[browser] A held tab's hidden page did not load ${url}:`, error));
  }
}
