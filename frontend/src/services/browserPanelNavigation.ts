import { panelApi } from './panelApi';
import { usePanelStore } from '../stores/panelStore';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
import { PANEL_CAPABILITIES, type BrowserPanelState, type ToolPanel } from '../../../shared/types/panels';
import type { Session } from '../types/session';

function browserPanelTitle(url: string): string {
  try {
    return new URL(url).host || 'Browser';
  } catch {
    return 'Browser';
  }
}

/**
 * Whether this session can visibly host and activate a Browser panel.
 * Project (main-repo) sessions and Pane Chat cannot; a missing session
 * context is treated as ineligible so no hidden panel is ever created.
 */
export function canHostSessionBrowser(session: Pick<Session, 'id' | 'isMainRepo'> | null | undefined): boolean {
  if (!session) return false;
  if (!PANEL_CAPABILITIES.browser.canAppearInWorktrees) return false;
  if (session.id === PANE_CHAT_SESSION_ID) return false;
  return session.isMainRepo !== true;
}

export type BrowserNavigationDecision = 'none' | 'navigate' | 'reload';

/**
 * Pure decision for BrowserPanel's state effect: navigate when the URL
 * differs, reload when the same URL arrives with a new navigation nonce,
 * otherwise do nothing.
 */
export function resolveBrowserNavigation(
  previous: { url: string; nonce: number | undefined },
  next: { currentUrl?: string; nonce?: number },
): BrowserNavigationDecision {
  if (!next.currentUrl) return 'none';
  if (next.currentUrl !== previous.url) return 'navigate';
  if (next.nonce !== undefined && next.nonce !== previous.nonce) return 'reload';
  return 'none';
}

// Module-scoped and monotonic so two concurrent navigations can never share a
// nonce (a read-modify-write on the store snapshot could).
let navigationNonceCounter = 0;
function nextNavigationNonce(): number {
  navigationNonceCounter += 1;
  return navigationNonceCounter;
}

export interface SessionBrowserNavigationOptions {
  title?: string;
  /** Apply `title` to an existing Browser panel as well (HTML previews do; terminal links keep the panel title). */
  retitleExisting?: boolean;
}

/** The backend calls the helper makes; injectable for tests. */
export type BrowserPanelApi = Pick<typeof panelApi, 'createPanel' | 'updatePanel' | 'setActivePanel'>;

/**
 * Single authoritative "create or navigate" for a session's Browser panel.
 *
 * Reuses the session's first Browser panel (updating its state so the panel
 * navigates through its own state effect — a fresh nonce makes a same-URL
 * request reload) or creates one, then activates it once. This is the only
 * navigation path; it deliberately does not dispatch any custom event.
 * Callers validate the URL before calling.
 */
export async function openUrlInSessionBrowser(
  sessionId: string,
  url: string,
  options: SessionBrowserNavigationOptions = {},
  api: BrowserPanelApi = panelApi,
): Promise<{ panelId: string; created: boolean }> {
  const store = usePanelStore.getState();
  const existing = store.getSessionPanels(sessionId).find((panel) => panel.type === 'browser');

  let browserPanel: ToolPanel;
  let created = false;
  if (existing) {
    // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
    const existingState = (existing.state.customState ?? {}) as BrowserPanelState;
    const nextState: BrowserPanelState = { ...existingState, currentUrl: url, navigationNonce: nextNavigationNonce() };
    const updates: Partial<ToolPanel> = { state: { ...existing.state, customState: nextState } };
    if (options.retitleExisting && options.title) updates.title = options.title;
    browserPanel = { ...existing, ...updates };
    // Commit locally first so the panel navigates immediately and concurrent
    // callers observe the newest state; then persist.
    store.updatePanelState(browserPanel);
    await api.updatePanel(browserPanel.id, updates);
  } else {
    browserPanel = await api.createPanel({
      sessionId,
      type: 'browser',
      title: options.title ?? browserPanelTitle(url),
      initialState: { customState: { currentUrl: url } },
    });
    // Deliberately no local addPanel: the main process broadcasts panel:created
    // and SessionView's listener both adds the panel and inserts it into the
    // split layout — but only when the panel is not already in the store.
    created = true;
  }

  store.setActivePanel(sessionId, browserPanel.id);
  await api.setActivePanel(sessionId, browserPanel.id);
  return { panelId: browserPanel.id, created };
}
