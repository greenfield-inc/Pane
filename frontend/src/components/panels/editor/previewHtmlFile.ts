/**
 * Shows an HTML file rendered in a browser tab: the tab already showing it, or a new
 * one. It never retargets a tab showing something else.
 */
import type { BrowserPanelState } from '../../../../../shared/types/panels';
import { panelApi } from '../../../services/panelApi';
import { activatePanel } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';
import { requestBrowserNavigation } from '../browser/browserNavigation';

export async function previewHtmlFileInBrowser(sessionId: string, filePath: string): Promise<void> {
  const browserPanel = await panelApi.openHtmlFile(sessionId, filePath);
  const store = usePanelStore.getState();
  const alreadyOpen = store.getSessionPanels(sessionId).some((panel) => panel.id === browserPanel.id);
  store.addPanel(browserPanel);
  await activatePanel(sessionId, browserPanel.id);
  // A tab already showing the file keeps its old render; reload it so a saved edit
  // appears. A new tab's first load already reads the current file.
  // SAFETY: The browser panel type discriminator establishes BrowserPanelState.
  const url = (browserPanel.state.customState as BrowserPanelState | undefined)?.currentUrl;
  if (alreadyOpen && url) requestBrowserNavigation({ url, sessionId, panelId: browserPanel.id });
}
