import { DEFAULT_BROWSER_SETTINGS, type LinksOpenIn } from '../../../shared/types/browser';
import { useConfigStore } from '../stores/configStore';

/**
 * Where a link opens. A link from your work (terminal output, a chat message, a card) names the
 * Pane it was clicked in and opens in a browser tab there, beside where it started. It goes to the
 * system browser when Settings > Links says so, when it is not an http or https link, or when it
 * has no Pane: Pane's own app links (installers, release notes, Discord) pass none.
 */
export function linkDestination(url: string, from: { paneId?: string; openIn?: LinksOpenIn }): 'pane' | 'system' {
  if (!from.paneId || (from.openIn ?? DEFAULT_BROWSER_SETTINGS.openLinksIn) === 'system') return 'system';
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? 'pane' : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Opens a page in a browser tab of the Pane, in the split beside the conversation, or brings back
 * the tab already showing it (`runpane panels open --split`). It never raises Pane's window.
 */
export async function openInPaneTab(paneId: string, url: string): Promise<void> {
  await window.electronAPI.invoke('runpane:panels:open', { paneId, url, placement: 'split', source: 'user' });
}

/**
 * Opens a link from your work where linkDestination says. A link whose Pane tab can't open goes
 * to the system browser instead.
 */
export async function openLink(url: string, paneId: string | undefined): Promise<void> {
  const openIn = useConfigStore.getState().config?.browser?.openLinksIn;
  if (paneId && linkDestination(url, { paneId, openIn }) === 'pane') {
    try {
      await openInPaneTab(paneId, url);
      return;
    } catch (error) {
      console.error('[openLink] Could not open the link in a Pane tab, so it opens in the system browser:', error);
    }
  }
  await window.electronAPI.openExternal(url);
}
