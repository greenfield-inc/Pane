import { app, session, webContents, type BrowserWindow } from 'electron';
import { SHARED_BROWSER_PARTITION } from '../../../../shared/constants/browserPartitions';
import { BROWSER_TAB_NOTICE_CHANNEL, type BrowserTabNotice } from '../../../../shared/types/browser';
import path from 'path';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { BrowserPanelState } from '../../../../shared/types/panels';
import { getPaneWebviewContextMap } from '../../core/runtime';
import type { PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { BrowserHost, LinkedComputers } from '../../ipc/browser';
import type { MachineConnections } from '../machineConnections';
import type { ConfigManager } from '../configManager';
import { BROWSER_MACHINE_CHANNEL } from './linkedBrowser';
import os from 'os';
import { paneScratchDirectory } from '../paneScratch';
import { panelManager } from '../panelManager';

/** The renderer hears where an agent clicked, to draw its cursor on the tab. */
const BROWSER_AGENT_CURSOR_EVENT = 'browser-panel:agent-cursor';

/** Browser tabs as this desktop's main process has them: the panel store and the pages its window registered. */
let machines: MachineConnections | undefined;

/** Main hands over the saved computers' connections once they exist; calls reach tabs a linked computer shows through them. */
export function setBrowserMachines(connections: MachineConnections): void {
  machines = connections;
}

/** The linked computers this desktop keeps connections to; none on a headless host. */
function linkedComputers(configManager: Pick<ConfigManager, 'getConfig'>): LinkedComputers | undefined {
  const connections = machines;
  if (!connections) return undefined;
  const config = configManager.getConfig();
  const name = os.hostname().replace(/\.local$/i, '');
  return {
    self: { id: config.machineId ?? name, name },
    online: () => (configManager.getConfig().remoteDaemon?.client.computers ?? [])
      .filter(computer => connections.machineState(computer.id)?.status === 'online')
      .map(computer => ({ id: computer.id, name: computer.label })),
    invoke: (machineId, request, timeoutMs) => connections.invokeOn(machineId, BROWSER_MACHINE_CHANNEL, [request], timeoutMs),
  };
}

export function electronBrowserHost(getMainWindow: () => BrowserWindow | null, commandRegistry: PaneCommandRegistry, configManager: Pick<ConfigManager, 'getConfig'>): BrowserHost {
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
    tunnels: (panelId) => new Map(newestContext(panelId)?.ports ?? []),
    hasWindow: () => getMainWindow() !== null,
    shotsDirectory: async (paneId) => path.join(await paneScratchDirectory(paneId) ?? os.tmpdir(), 'browser-screenshots'),
    showCursor: (panelId, x, y) => getMainWindow()?.webContents.send(BROWSER_AGENT_CURSOR_EVENT, { panelId, x, y }),
    linked: () => linkedComputers(configManager),
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

/** The newest live page's registration for a tab. */
function newestContext(panelId: string) {
  const page = newestPage(panelId);
  return page ? getPaneWebviewContextMap().get(page.id) : undefined;
}

/** A remounted tab registers a new page id and the old ones stay mapped, so the newest live one wins. */
function newestPage(panelId: string): Electron.WebContents | undefined {
  let newest: Electron.WebContents | undefined;
  for (const [id, context] of getPaneWebviewContextMap()) {
    if (context.panelId !== panelId) continue;
    const contents = webContents.fromId(id);
    // Only a browser tab's own page: never another kind of WebContents that reused a mapped id.
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') continue;
    if (!newest || contents.id > newest.id) newest = contents;
  }
  return newest;
}
