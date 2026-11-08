import { create } from 'zustand';
import { useNavigationStore } from '../../stores/navigationStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { useSessionStore } from '../../stores/sessionStore';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/**
 * Approvals there and back (D-239, D-251): one key opens Approvals and the
 * same key, or Esc, returns to exactly where you were: the view, the Pane or
 * Session, the focused split and its tab, the focused field or page, and the
 * scroll. Opening Approvals can show another Pane beside an item, so the one
 * you left may remount; its place is captured on the way in and put back on
 * the way out.
 */

interface ScrollMark {
  /** Child indexes from the tab's panel element down to the scroller. */
  path: number[];
  top: number;
  left: number;
}

/** Where focus was when Approvals opened, read from the page. */
interface ReturnPlace {
  /** The split (`data-panel-group-id`) that had focus. */
  groupId: string | null;
  /** Its active tab's panel element id, so the same tab's content is found again. */
  tabPanelId: string | null;
  /** The region that had focus when it was not a split (the sidebar, the right panel, the terminal). */
  region: string | null;
  /** What held focus inside: a terminal, a text field, a browser page, or something else. */
  focusKind: 'terminal' | 'field' | 'page' | 'other';
  scroll: ScrollMark[];
  /** The browser page's own scroll, read from the guest. */
  page: { x: number; y: number } | null;
  /** Short words for the back hint: the Pane or Session name and the tab. */
  label: string | null;
}

let pendingReturn: ReturnPlace | null = null;
let returnSessionId: string | undefined;

/** What the Approvals title bar names as "back" (D-239). */
export const useApprovalsBackStore = create<{ label: string | null }>(() => ({ label: null }));

function childPath(root: Element, target: Element): number[] | null {
  const path: number[] = [];
  let node: Element | null = target;
  while (node && node !== root) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === root ? path : null;
}

function atPath(root: Element, path: readonly number[]): HTMLElement | null {
  let node: Element | null = root;
  for (const index of path) {
    node = node?.children.item(index) ?? null;
    if (!node) return null;
  }
  // SAFETY: the path was recorded from HTML elements inside the same tab panel.
  return node as HTMLElement | null;
}

function scrollers(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('*')).filter(element =>
    (element.scrollTop > 0 || element.scrollLeft > 0)
    && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1));
}

function focusKindOf(element: Element | null): ReturnPlace['focusKind'] {
  if (!element) return 'other';
  if (element.classList.contains('xterm-helper-textarea')) return 'terminal';
  if (element.tagName === 'WEBVIEW') return 'page';
  // SAFETY: tagName and isContentEditable are read only for HTML elements, checked first.
  if (element instanceof HTMLElement && (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' || element.isContentEditable)) return 'field';
  return 'other';
}

interface GuestPage extends HTMLElement {
  /** A <webview>'s script result: whatever the page returned, as JSON. */
  executeJavaScript: (code: string) => Promise<JsonValue>;
  isLoading?: () => boolean;
}

function isGuestPage(element: Element | null): element is GuestPage {
  return Boolean(element && element.tagName === 'WEBVIEW' && 'executeJavaScript' in element);
}

/**
 * Reads the place keyboard focus is in, before Approvals replaces it. Every
 * DOM read happens now; only the browser page's own scroll arrives later.
 */
interface CapturedReturn {
  place: ReturnPlace;
  /** The browser page's scroll, read from the guest after the rest. */
  page: Promise<ReturnPlace['page']>;
}

/** A guest page's `[scrollX, scrollY]`, or null for anything else. */
function pageScrollOf(read: JsonValue): ReturnPlace['page'] {
  const pair = decodeOptionalBoundary(read, boundary.array(boundary.number));
  return pair && pair.length === 2 ? { x: pair[0], y: pair[1] } : null;
}

function captureReturnPlace(): CapturedReturn {
  const active = document.activeElement;
  const group = active?.closest<HTMLElement>('[data-panel-group-id]')
    ?? document.querySelector<HTMLElement>('[data-focus-region="main"] [data-panel-group-id][data-group-focused="true"]');
  const tabPanel = group?.querySelector<HTMLElement>('[role="tabpanel"]:not([aria-hidden="true"])') ?? null;
  const region = active?.closest('[data-focus-region]')?.getAttribute('data-focus-region') ?? null;
  const scroll = tabPanel
    ? scrollers(tabPanel).flatMap(element => {
      const path = childPath(tabPanel, element);
      return path ? [{ path, top: element.scrollTop, left: element.scrollLeft }] : [];
    })
    : [];
  const tabLabel = tabPanel ? document.getElementById(tabPanel.getAttribute('aria-labelledby') ?? '')?.getAttribute('aria-label') ?? null : null;
  const where = document.querySelector('[data-testid="window-title-bar-label"]')?.textContent?.trim() ?? null;
  const label = [where?.split('·').pop()?.trim() || where, tabLabel].filter(Boolean).join(' · ') || null;
  const place: ReturnPlace = {
    groupId: group?.getAttribute('data-panel-group-id') ?? null,
    tabPanelId: tabPanel?.id ?? null,
    region: group ? 'main' : region,
    focusKind: focusKindOf(active),
    scroll,
    page: null,
    label,
  };
  const guest = tabPanel?.querySelector('webview') ?? null;
  const page = isGuestPage(guest)
    ? guest.executeJavaScript('[window.scrollX, window.scrollY]').then(pageScrollOf, () => null)
    : Promise.resolve(null);
  return { place, page };
}

const RESTORE_WINDOW_MS = 4000;

function focusPlace(container: HTMLElement, kind: ReturnPlace['focusKind']): void {
  const selector = kind === 'terminal' ? '.xterm-helper-textarea'
    : kind === 'field' ? 'textarea:not([disabled]), [contenteditable="true"], input:not([type="hidden"])'
      : kind === 'page' ? 'webview'
        : 'button, [href], [tabindex]:not([tabindex="-1"])';
  const target = container.querySelector<HTMLElement>(selector) ?? container;
  if (!target.hasAttribute('tabindex') && target === container) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/** Puts focus and scroll back once the view you left has rendered again. */
function restoreReturnPlace(place: ReturnPlace): void {
  const started = Date.now();
  let focused = false;
  const pendingScroll = [...place.scroll];
  let pageDone = place.page === null;
  const step = () => {
    const group = place.groupId
      ? document.querySelector<HTMLElement>(`[data-panel-group-id="${CSS.escape(place.groupId)}"]`)
      : null;
    const tabPanel = place.tabPanelId ? document.getElementById(place.tabPanelId) : null;
    if (!focused) {
      if (group) {
        focusPlace(tabPanel ?? group, place.focusKind);
        focused = true;
      } else if (!place.groupId && place.region) {
        const region = document.querySelector<HTMLElement>(`[data-focus-region="${CSS.escape(place.region)}"]`);
        if (region) { focusPlace(region, place.focusKind); focused = true; }
      }
    }
    if (tabPanel) {
      for (let index = pendingScroll.length - 1; index >= 0; index -= 1) {
        const mark = pendingScroll[index];
        const element = atPath(tabPanel, mark.path);
        if (!element) continue;
        element.scrollTop = mark.top;
        element.scrollLeft = mark.left;
        // Content may still be arriving; done once the scroller reaches the mark.
        if (Math.abs(element.scrollTop - mark.top) <= 1) pendingScroll.splice(index, 1);
      }
      const guest = tabPanel.querySelector('webview');
      if (!pageDone && place.page && isGuestPage(guest) && !(guest.isLoading?.() ?? false)) {
        const { x, y } = place.page;
        void guest.executeJavaScript(`window.scrollTo(${x}, ${y}); [window.scrollX, window.scrollY]`)
          .then(read => {
            const now = pageScrollOf(read);
            if (now && Math.abs(now.y - y) <= 1) pageDone = true;
          })
          .catch(() => undefined);
      }
    }
    const done = focused && pendingScroll.length === 0 && pageDone;
    if (!done && Date.now() - started < RESTORE_WINDOW_MS) setTimeout(step, 50);
  };
  requestAnimationFrame(() => requestAnimationFrame(step));
}

/** Opens Approvals (on `itemId` when given), remembering the view and Pane to come back to. */
export function openApprovals(itemId?: string): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'notify') {
    returnSessionId = useOrchestrationSessionStore.getState().selectedSessionId;
    // Read the place before the view changes; the guest page's scroll arrives a moment later.
    const { place, page } = captureReturnPlace();
    pendingReturn = place;
    useApprovalsBackStore.setState({ label: place.label });
    void page.then(scroll => { if (pendingReturn === place) place.page = scroll; });
  }
  navigation.navigateToNotify({ itemId, returnPaneId: useSessionStore.getState().activeSessionId });
}

/** Leaves Approvals for exactly where you were. */
function leaveApprovals(): void {
  const navigation = useNavigationStore.getState();
  if (navigation.activeView !== 'notify') return;
  const place = pendingReturn;
  const sessionId = returnSessionId;
  pendingReturn = null;
  returnSessionId = undefined;
  useApprovalsBackStore.setState({ label: null });
  const back = navigation.leaveApprovals();
  const sessions = useSessionStore.getState();
  // Selecting a worker's item shows its Pane; going back restores the Pane you were on.
  if (back.paneId !== sessions.activeSessionId) void sessions.setActiveSession(back.paneId);
  if (back.view === 'pane-chat' && sessionId && useOrchestrationSessionStore.getState().selectedSessionId !== sessionId) {
    void useOrchestrationSessionStore.getState().select({ sessionId }).catch(() => undefined);
  }
  if (place) restoreReturnPlace(place);
}

/** The badge and the Notify shortcut: opens Approvals, or, while it is open, returns to where you were. */
export function toggleApprovals(): void {
  if (useNavigationStore.getState().activeView !== 'notify') {
    openApprovals();
    return;
  }
  leaveApprovals();
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const element = target;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable
    || element.closest('.xterm') !== null;
}

/**
 * Esc in Approvals goes back too (D-251), except while typing an answer or
 * with a menu or dialog open, which take their own Esc first.
 */
export function handleApprovalsEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (useNavigationStore.getState().activeView !== 'notify') return;
  if (isTypingTarget(event.target)) return;
  if (document.querySelector('[role="menu"], [role="listbox"], [aria-modal="true"]')) return;
  event.preventDefault();
  leaveApprovals();
}
