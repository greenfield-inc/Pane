import { DEFAULT_BROWSER_SETTINGS, type LinksOpenIn } from '../../../shared/types/browser';
import { useConfigStore } from '../stores/configStore';
import { isMac } from './platformUtils';

/** Whether `url` is an absolute http or https link, the only kind a Pane tab opens. */
export function isWebLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** A left click, which opens a link. A right-click, or Ctrl-click on macOS, shows the link popover instead. */
export function opensLink(event: { button: number; ctrlKey: boolean }): boolean {
  return event.button === 0 && !(isMac() && event.ctrlKey);
}

/** A Cmd-click (macOS) or Ctrl-click (Windows, Linux): the link opens where a plain click doesn't. */
export function swapsDestination(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

/**
 * Where a link opens. A link from your work (terminal output, a chat message, a card) names the
 * Pane it was clicked in. A plain click opens it where Settings > Links says (a browser tab in that
 * Pane by default); `swap` (Cmd-click or Ctrl-click) opens it in the other place. It always goes to
 * the system browser when it is not an http or https link, or when it has no Pane: Pane's own app
 * links (installers, release notes, Discord) pass none.
 */
export function linkDestination(url: string, from: { paneId?: string; openIn?: LinksOpenIn; swap?: boolean }): 'pane' | 'system' {
  if (!from.paneId || !isWebLink(url)) return 'system';
  const preferred = from.openIn ?? DEFAULT_BROWSER_SETTINGS.openLinksIn;
  if (!from.swap) return preferred;
  return preferred === 'pane' ? 'system' : 'pane';
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
export async function openLink(url: string, paneId: string | undefined, options: { swap?: boolean } = {}): Promise<void> {
  const openIn = useConfigStore.getState().config?.browser?.openLinksIn;
  if (paneId && linkDestination(url, { paneId, openIn, swap: options.swap }) === 'pane') {
    try {
      await openInPaneTab(paneId, url);
      return;
    } catch (error) {
      console.error('[openLink] Could not open the link in a Pane tab, so it opens in the system browser:', error);
    }
  }
  await window.electronAPI.openExternal(url);
}
