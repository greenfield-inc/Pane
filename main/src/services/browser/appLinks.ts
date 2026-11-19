import { app } from 'electron';
import { randomUUID } from 'crypto';
import { PaneError } from '../../../../shared/paneError';
import type { BrowserTabNotice } from '../../../../shared/types/browser';
import { appLinkOrNull } from '../../utils/externalUrl';
import { openAppLink } from '../../utils/openExternalUrl';

/** App links pages asked for, by offer id, until the person presses Open or the list rolls over. */
const offers = new Map<string, string>();
const MAX_OFFERS = 50;

/**
 * A page in a browser tab asked to open an app (zoommtg:, slack:). The tab shows "This page wants
 * to open <app>. Open · Cancel"; only Open (openOfferedAppLink) hands the link to the OS.
 */
export function offerAppLink(url: string, panelId: string, notify: (panelId: string, notice: BrowserTabNotice) => void): void {
  const link = appLinkOrNull(url);
  if (link === null) {
    console.warn('[BrowserPanel] Refused a page\'s request to open a link that reaches files or programs directly');
    return;
  }
  const id = randomUUID();
  offers.set(id, link);
  for (const old of offers.keys()) {
    if (offers.size <= MAX_OFFERS) break;
    offers.delete(old);
  }
  // macOS names an app bundle ("zoom.us.app"); the notice reads "zoom.us".
  const appName = app.getApplicationNameForProtocol(link).replace(/\.app$/i, '');
  notify(panelId, { kind: 'app', id, app: appName || null, scheme: new URL(link).protocol.slice(0, -1) });
}

/** The person pressed Open on an app link's notice: the OS opens it, once. */
export async function openOfferedAppLink(id: string): Promise<void> {
  const link = offers.get(id);
  offers.delete(id);
  if (!link) {
    throw new PaneError('ERR_APP_LINK_GONE', 'Pane no longer has the link this page asked to open, so nothing was opened.', 'Click the link in the page again.');
  }
  await openAppLink(link);
}
