import { webContents, type BrowserWindow } from 'electron';
import path from 'path';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { BrowserPanelState, ToolPanel } from '../../../../shared/types/panels';
import { getPaneWebviewContextMap } from '../../core/runtime';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { BrowserHost } from '../../ipc/browser';
import { getAppDirectory } from '../../utils/appDirectory';
import { panelManager } from '../panelManager';

/** The renderer hears where an agent clicked, to draw its cursor on the tab. */
export const BROWSER_AGENT_CURSOR_EVENT = 'browser-panel:agent-cursor';

/** Browser tabs as this desktop's main process has them: the panel store and the pages its window registered. */
export function electronBrowserHost(getMainWindow: () => BrowserWindow | null, commandRegistry: PaneCommandRegistry): BrowserHost {
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
    show: (tab) => panelManager.setActivePanel(tab.sessionId, tab.id, 'split'),
    close: async (tab) => {
      const deleted = decodeBoundary(await commandRegistry.invoke('panels:delete', [tab.id]), boundary.object({ success: boundary.boolean, error: boundary.optional(boundary.string) }));
      if (!deleted.success) throw new Error(deleted.error ?? 'Pane could not close the tab.');
    },
    update: async (tab, state) => {
      const current = panelManager.getPanel(tab.id) ?? tab;
      await panelManager.updatePanel(tab.id, { state: { ...current.state, customState: state } });
    },
    page: (panelId) => newestPage(panelId),
    hasWindow: () => getMainWindow() !== null,
    shotsDirectory: () => path.join(getAppDirectory(), 'browser', 'screenshots'),
    showCursor: (panelId, x, y) => getMainWindow()?.webContents.send(BROWSER_AGENT_CURSOR_EVENT, { panelId, x, y }),
  };
}

/** A remounted tab registers a new page id and the old ones stay mapped, so the newest live one wins. */
function newestPage(panelId: string): Electron.WebContents | undefined {
  let newest: Electron.WebContents | undefined;
  for (const [id, context] of getPaneWebviewContextMap()) {
    if (context.panelId !== panelId) continue;
    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed()) continue;
    if (!newest || contents.id > newest.id) newest = contents;
  }
  return newest;
}
