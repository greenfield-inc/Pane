/**
 * Keyboard focus across the window's regions (D-234, D-237): which region has
 * focus, moving to the stop in a direction (⌘⌥+arrows), cycling regions (F6),
 * and focusing the sidebar (⌘0).
 *
 * Regions mark themselves with `data-focus-region` (sidebar, main,
 * right-panel, terminal, approvals); split groups with `data-panel-group-id`.
 * A region that can be shown collapsed says so with `data-region-open`.
 * The page is the source of truth: stops are read from what is on screen, so
 * worktree Panes, Session tiles, the main-repo Pane and the other views all
 * work the same way.
 */
import { create } from 'zustand';
import { useNavigationStore } from '../stores/navigationStore';
import { holdCursorThroughSwitch, machineSwitchInFlight, releaseSwitchCursorHold } from './switchCursorHold';
import {
  SESSION_CURSOR_ATTRIBUTE,
  SESSION_CURSOR_MACHINE_ATTRIBUTE,
  cursorFollowEnabled,
  pauseSessionCursor,
  pendingCursorSession,
  settleSessionCursor,
  showSessionAtCursor,
  windowMachineId,
} from './sessionCursor';
import { engageKey, engageRemoteSession, holdRemoteText, onEngageSwitch, useRemoteEngage } from './remoteEngage';
import {
  sidebarListKey,
  stepStop,
  stopInDirection,
  type FocusDirection,
  type FocusStop,
  type FocusStopKind,
} from '../utils/focusStops';

type FocusRegion = 'sidebar' | 'main' | 'right-panel' | 'terminal' | 'approvals';

const REGIONS: ReadonlySet<string> = new Set(['sidebar', 'main', 'right-panel', 'terminal', 'approvals']);

interface FocusRegionState {
  /** The region holding keyboard focus, or the one that last did. */
  region: FocusRegion | null;
}

export const useFocusRegionStore = create<FocusRegionState>(() => ({ region: null }));

/** Where focus was before it entered the sidebar, for Esc (D-234). */
let returnTarget: HTMLElement | null = null;
/** The last stop that held focus, when focus has since left the page (a webview, a dialog). */
let lastStopElement: HTMLElement | null = null;

function regionOf(element: Element | null): FocusRegion | null {
  const value = element?.closest('[data-focus-region]')?.getAttribute('data-focus-region');
  // SAFETY: REGIONS holds exactly the FocusRegion values, checked just before.
  return value && REGIONS.has(value) ? (value as FocusRegion) : null;
}

/** Follows focus as it moves (by mouse, Tab, or these keys). */
export function noteFocusIn(target: Element | null): void {
  const region = regionOf(target);
  if (!region) return;
  if (useFocusRegionStore.getState().region !== region) useFocusRegionStore.setState({ region });
  // SAFETY: focusin targets on the window are elements.
  const element = target as HTMLElement;
  if (region !== 'sidebar') returnTarget = element;
  const stop = stopElementFor(element);
  if (stop) lastStopElement = stop;
}

function isShown(element: Element): boolean {
  if (element.closest('[inert], [aria-hidden="true"]')) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 8 && rect.height > 8;
}

function rectOf(element: Element) {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

const stopIds = new WeakMap<Element, string>();
let nextStopId = 0;
function idFor(element: Element): string {
  let id = stopIds.get(element);
  if (!id) {
    id = `stop-${nextStopId += 1}`;
    stopIds.set(element, id);
  }
  return id;
}

function asStop(element: HTMLElement, kind: FocusStopKind, preferred = false): FocusStop<HTMLElement> {
  return { id: idFor(element), kind, rect: rectOf(element), preferred, ref: element };
}

function queryShown(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isShown);
}

/** Every place focus can stop right now, read from the page. */
function collectFocusStops(): FocusStop<HTMLElement>[] {
  const stops: FocusStop<HTMLElement>[] = [];
  const sidebar = queryShown('[data-focus-region="sidebar"].pane-sidebar-shell')[0];
  if (sidebar) stops.push(asStop(sidebar, 'sidebar'));

  const mains = queryShown('[data-focus-region="main"]');
  const groups = mains.flatMap(main => Array.from(main.querySelectorAll<HTMLElement>('[data-panel-group-id]')))
    .filter(group => isShown(group) && regionOf(group) === 'main');
  for (const group of new Set(groups)) {
    stops.push(asStop(group, 'group', group.getAttribute('data-group-focused') === 'true'));
  }
  if (groups.length === 0) {
    // A view without splits (Home, the main-repo Pane, Loops) is one stop.
    const outermost = mains.find(main => !mains.some(other => other !== main && other.contains(main)));
    if (outermost) stops.push(asStop(outermost, 'main'));
  }
  for (const panel of queryShown('[data-focus-region="right-panel"]:not([data-region-open="false"])')) {
    stops.push(asStop(panel, 'right-panel'));
  }
  for (const terminal of queryShown('[data-focus-region="terminal"][data-region-open="true"]')) {
    stops.push(asStop(terminal, 'terminal'));
  }
  for (const approvals of queryShown('[data-focus-region="approvals"]')) {
    stops.push(asStop(approvals, 'approvals'));
  }
  // An approval laid over a Session's right split hides it: the approval is the stop there, not the page under it (D-335).
  const covers = stops.filter(stop => stop.kind === 'approvals');
  return stops.filter(stop => stop.kind !== 'group' || !covers.some(cover => coversRect(cover.rect, stop.rect)));
}

function coversRect(outer: FocusStop['rect'], inner: FocusStop['rect']): boolean {
  const slack = 2;
  return inner.left >= outer.left - slack && inner.right <= outer.right + slack
    && inner.top >= outer.top - slack && inner.bottom <= outer.bottom + slack;
}

function stopElementFor(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>('[data-panel-group-id]')
    ?? element.closest<HTMLElement>('[data-focus-region="right-panel"], [data-focus-region="terminal"], [data-focus-region="approvals"]')
    ?? element.closest<HTMLElement>('[data-focus-region="sidebar"]')
    ?? element.closest<HTMLElement>('[data-focus-region="main"]');
}

function currentStop(stops: readonly FocusStop<HTMLElement>[]): FocusStop<HTMLElement> | null {
  const active = document.activeElement;
  const fromActive = active && active !== document.body ? stopElementFor(active) : null;
  // The machine switcher sits in the title bar but belongs to the sidebar.
  const sidebarItem = active?.closest('[data-sidebar-item]') ? stops.find(stop => stop.kind === 'sidebar') : undefined;
  if (sidebarItem) return sidebarItem;
  const element = fromActive ?? lastStopElement;
  if (!element) return null;
  return stops.find(stop => stop.ref === element)
    ?? stops.find(stop => stop.ref.contains(element))
    ?? null;
}

/** A chat tab's message box. */
const CHAT_COMPOSER = '[data-chat-composer]';

const FOCUS_TARGETS = [
  CHAT_COMPOSER,
  '.xterm-helper-textarea',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  'webview',
  'input:not([type="hidden"]):not([disabled])',
  'button:not([disabled]), [href], select:not([disabled]), [tabindex]:not([tabindex="-1"])',
];

/** Moves DOM focus into a region: its terminal, its composer or field, its page, or its first control. */
function focusInside(container: HTMLElement): boolean {
  // A region can name where arriving focus lands (an approval column: its own pager, not its reply box).
  const entry = Array.from(container.querySelectorAll<HTMLElement>('[data-focus-entry]')).find(isShown);
  if (entry) {
    entry.focus({ preventScroll: true });
    if (document.activeElement === entry) return true;
  }
  const scope = container.querySelector<HTMLElement>('[role="tabpanel"]:not([aria-hidden="true"])') ?? container;
  for (const selector of FOCUS_TARGETS) {
    const target = Array.from(scope.querySelectorAll<HTMLElement>(selector)).find(isShown);
    if (target) {
      target.focus({ preventScroll: true });
      // A focused <webview> is the document's active element too.
      if (document.activeElement === target) return true;
    }
  }
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
  container.focus({ preventScroll: true });
  return document.activeElement === container;
}

// --- Tiled Sessions (T-45) ---

/**
 * The focused tile of the Session layout, if Sessions are shown. Focus that
 * enters any other tile selects that tile's Session, so whatever Enter or a
 * tab key moves focus to is looked for only inside this one. A Session shown
 * beside something else (an approval's origin, `data-session-inline`) is not
 * a layout tile.
 */
const LAYOUT_TILE = '[data-session-tile]:not([data-session-inline])';

function focusedSessionTile(): HTMLElement | null {
  return queryShown(`${LAYOUT_TILE}[data-session-focused="true"]`)[0] ?? null;
}

/** Whether `element` belongs to `tile` itself, not to a Session shown inside it. */
function ownedBy(tile: HTMLElement, element: Element): boolean {
  return element.closest('[data-session-tile]') === tile;
}

/** A main-area split that holds the focus of its view (relative to the main region). */
const FOCUSED_SPLIT = '[data-panel-group-id][data-group-focused="true"]';

/**
 * The shown elements of the main area matching `selector` (relative to the
 * main region): within the focused Session tile when Sessions are tiled.
 */
function inMainArea(selector: string): HTMLElement[] {
  const tile = focusedSessionTile();
  const found = queryShown(`[data-focus-region="main"] ${selector}`);
  return tile ? found.filter(element => ownedBy(tile, element)) : found;
}

function sidebarItems(): HTMLElement[] {
  return sortedByDocument(queryShown('[data-sidebar-item]'));
}

function sortedByDocument(elements: HTMLElement[]): HTMLElement[] {
  return elements.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

let sidebarCursor: HTMLElement | null = null;

/** Focus Sidebar (⌘0): expands a collapsed sidebar and puts the cursor on the open Pane's row. */
export function focusSidebar(): void {
  const navigation = useNavigationStore.getState();
  const place = () => {
    const items = sidebarItems();
    const target = items.find(item => item.getAttribute('aria-current') === 'page')
      ?? (sidebarCursor && items.includes(sidebarCursor) ? sidebarCursor : null)
      ?? items.find(item => item.hasAttribute('data-row-open'))
      ?? items[0];
    target?.focus({ preventScroll: false });
  };
  if (navigation.sidebarCollapsed) {
    navigation.setSidebarCollapsed(false);
    requestAnimationFrame(() => requestAnimationFrame(place));
    return;
  }
  place();
}

function focusStop(stop: FocusStop<HTMLElement>): void {
  releaseCursorHold?.();
  if (stop.kind === 'sidebar') {
    focusSidebar();
    return;
  }
  focusInside(stop.ref);
  lastStopElement = stop.ref;
}

/** ⌘⌥+arrows: the stop in that direction, across region edges. */
export function moveFocus(dir: FocusDirection): boolean {
  const stops = collectFocusStops();
  const from = currentStop(stops);
  if (!from) {
    const first = stops.find(stop => stop.kind === 'group' || stop.kind === 'main');
    if (first) focusStop(first);
    return Boolean(first);
  }
  const target = stopInDirection(stops, from, dir);
  if (!target) return false;
  focusStop(target);
  return true;
}

/** F6 / ⇧F6: the next or previous region (VS Code's focusNextPart). */
export function stepFocus(delta: 1 | -1): void {
  const stops = collectFocusStops();
  const target = stepStop(stops, currentStop(stops)?.id ?? null, delta);
  if (target) focusStop(target);
}

/**
 * Into the main area from the sidebar (Enter on a row): its focused group.
 *
 * With Sessions tiled, only the focused tile holds what Enter just opened, and
 * focusing any other tile selects that tile's Session (T-45). While the opened
 * Session is still loading its tile has no group yet, so focus waits on the
 * tile itself (not its first control, the tile's close button) rather than
 * going to the first group on screen, which is another Session's.
 */
function focusMainArea(): void {
  const tile = focusedSessionTile();
  const stops = collectFocusStops().filter(stop => !tile || ownedBy(tile, stop.ref));
  const target = stops.find(stop => stop.kind === 'group' && stop.preferred)
    ?? stops.find(stop => stop.kind === 'group' || stop.kind === 'main' || stop.kind === 'approvals');
  if (target) {
    focusStop(target);
  } else if (tile) {
    if (!tile.hasAttribute('tabindex')) tile.setAttribute('tabindex', '-1');
    tile.focus({ preventScroll: true });
  }
}

/**
 * After a tab key (⌘⇧[ ⌘⇧] ⌘⇧1-9) shows another tab, keyboard focus follows
 * into it, unless focus is somewhere else on purpose (the sidebar, a dialog).
 */
export function focusActiveTabSoon(): void {
  const from = document.activeElement;
  if (from && from !== document.body && regionOf(from) !== 'main') return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const group = inMainArea(FOCUSED_SPLIT)[0];
    if (group) focusInside(group);
  }));
}

// --- A Session's approval column and the window's keys (D-336) ---

/** The approval column within `scope` that holds keyboard focus, if any. */
export function focusedApprovalColumn(scope: Element | null): HTMLElement | null {
  const column = document.activeElement?.closest<HTMLElement>('[data-focus-region="approvals"]') ?? null;
  return column && scope?.contains(column) ? column : null;
}

function approvalColumnTabs(column: HTMLElement): HTMLElement[] {
  return Array.from(column.querySelectorAll<HTMLElement>('[role="tab"][data-approval-tab]')).filter(isShown);
}

export function approvalColumnTabCount(column: HTMLElement): number {
  return approvalColumnTabs(column).length;
}

/**
 * The tab keys (next, previous, a number) show another of the column's tabs:
 * Decide, Summary, the references, the origin chat. Focus stays
 * in the column; if it was in the tab that went away, it lands on the tab
 * just shown, so the next tab key still reaches Pane (a Summary frame or a
 * page would keep it).
 */
export function showApprovalColumnTab(column: HTMLElement, pick: (current: number, count: number) => number): void {
  const tabs = approvalColumnTabs(column);
  const next = tabs[pick(tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'), tabs.length)];
  if (!next) return;
  next.click();
  requestAnimationFrame(() => {
    if (!column.isConnected || column.contains(document.activeElement)) return;
    if (next.isConnected) next.focus({ preventScroll: true });
    else focusInside(column);
  });
}

/** Esc in a Session's approval column: back to the chat it sits beside. */
export function leaveApprovalColumn(): void {
  releaseCursorHold?.();
  focusMainArea();
}

// --- Maximize and minimize (P4) ---

export interface RegionActions {
  /** Maximize the region over the main area, or restore it (⌘K ⌘M). */
  toggleMaximize?: () => void;
  /** Collapse a side region: the sidebar to its rail, the right panel, the terminal (⌘⇧M). */
  minimize?: () => void;
}

const regionActions = new WeakMap<Element, RegionActions>();

/** A region element says what maximize and minimize do for it; returns the unregister. */
export function registerRegionActions(element: Element, actions: RegionActions): () => void {
  regionActions.set(element, actions);
  return () => {
    if (regionActions.get(element) === actions) regionActions.delete(element);
  };
}

function actionsAtFocus(): RegionActions | null {
  const stops = collectFocusStops();
  let element: Element | null = currentStop(stops)?.ref ?? null;
  // A maximized side region covers the main area; it may not be a stop of its own then.
  if (!element && document.activeElement) element = document.activeElement;
  while (element) {
    const actions = regionActions.get(element);
    if (actions) return actions;
    element = element.parentElement?.closest('[data-panel-group-id], [data-focus-region]') ?? null;
  }
  return null;
}

/** ⌘K ⌘M: maximize the focused region (a split, a Session tile, the sidebar or the right panel), or restore it. */
export function toggleMaximizeAtFocus(): boolean {
  const actions = actionsAtFocus();
  if (!actions?.toggleMaximize) return false;
  actions.toggleMaximize();
  return true;
}

/** ⌘⇧M: minimize the focused side region and move focus to the main area. A split does nothing. */
export function minimizeAtFocus(): boolean {
  const actions = actionsAtFocus();
  if (!actions?.minimize) return false;
  actions.minimize();
  requestAnimationFrame(() => requestAnimationFrame(focusMainArea));
  return true;
}

// --- The sidebar as a keyboard list ---

function expandableFor(item: HTMLElement): HTMLElement | null {
  if (item.hasAttribute('aria-expanded')) return item;
  // A Session row opens with one button and expands with another beside it.
  return item.closest('[data-sidebar-row]')?.querySelector<HTMLElement>('[aria-expanded]') ?? null;
}

/** The project or Session row a Pane row sits under, from its `aria-controls` list. */
function parentItem(item: HTMLElement): HTMLElement | null {
  let container = item.parentElement;
  while (container) {
    if (container.id) {
      const control = document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(container.id)}"]`);
      const owner = control?.hasAttribute('data-sidebar-item')
        ? control
        : control?.closest('[data-sidebar-row]')?.querySelector<HTMLElement>('[data-sidebar-item]');
      if (owner && owner !== item) return owner;
    }
    container = container.parentElement;
  }
  return null;
}

/** How long "open and stay" (Space) keeps the cursor while the opened Pane mounts. */
const HOLD_CURSOR_MS = 3000;
let releaseCursorHold: (() => void) | null = null;

/**
 * Keeps focus on `target` for a moment while a view mounts around it: a newly
 * opened Pane's terminal or composer focuses itself as it loads, and that
 * focus is handed back. A click anywhere ends the hold at once. Used by Space
 * in the sidebar ("open and stay", D-234) and by Approvals' return (D-239).
 */
export function holdFocusOn(target: () => HTMLElement | null): void {
  releaseCursorHold?.();
  const until = Date.now() + HOLD_CURSOR_MS;
  const onFocusIn = (event: FocusEvent) => {
    if (Date.now() > until) { release(); return; }
    const element = target();
    // SAFETY: focusin targets on the window are elements.
    if (!element?.isConnected || element.contains(event.target as Node | null)) return;
    requestAnimationFrame(() => element.focus({ preventScroll: true }));
  };
  const release = () => {
    window.removeEventListener('focusin', onFocusIn, true);
    window.removeEventListener('mousedown', release, true);
    clearTimeout(timer);
    if (releaseCursorHold === release) releaseCursorHold = null;
  };
  const timer = setTimeout(release, HOLD_CURSOR_MS);
  window.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('mousedown', release, true);
  releaseCursorHold = release;
}

function holdSidebarCursor(): void {
  holdFocusOn(() => sidebarCursor);
}

function refocus(item: HTMLElement): void {
  // A click may re-render the row; find the same item again by its key.
  const key = item.getAttribute('data-sidebar-key');
  requestAnimationFrame(() => {
    if (item.isConnected) { item.focus({ preventScroll: true }); return; }
    const again = key ? document.querySelector<HTMLElement>(`[data-sidebar-key="${CSS.escape(key)}"]`) : null;
    again?.focus({ preventScroll: true });
  });
}

/**
 * Arrow keys walk the sidebar's rows, top buttons included (D-239): ↑ ↓ (or k j) move,
 * Home End jump, ← → collapse or expand (or step to the parent row), Enter
 * opens and moves focus into the work, Space opens and keeps the cursor, Esc
 * goes back to where focus was. Alt+↑/↓ stays row reordering.
 */
export function handleSidebarListKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  // SAFETY: keydown targets on the window are elements.
  const target = event.target as HTMLElement | null;
  const item = target?.closest<HTMLElement>('[data-sidebar-item]');
  if (!item || target !== item) return;
  const items = sidebarItems();
  const index = items.indexOf(item);
  if (index === -1) return;
  sidebarCursor = item;

  const moveTo = (next: HTMLElement | undefined) => {
    event.preventDefault();
    if (!next) return;
    sidebarCursor = next;
    next.focus({ preventScroll: false });
    next.scrollIntoView({ block: 'nearest' });
    // Arrow keys open chat Sessions (T-87): the row's Session shows, and focus stays here.
    if (cursorFollowEnabled()) {
      const sessionId = next.getAttribute(SESSION_CURSOR_ATTRIBUTE);
      if (sessionId) showSessionAtCursor(sessionId, next.getAttribute(SESSION_CURSOR_MACHINE_ATTRIBUTE) ?? undefined);
      else pauseSessionCursor();
    }
  };

  switch (sidebarListKey(event.key)) {
    case 'ArrowDown':
      if (!event.shiftKey) moveTo(items[index + 1]);
      return;
    case 'ArrowUp':
      if (!event.shiftKey) moveTo(items[index - 1]);
      return;
    case 'Home':
      moveTo(items[0]);
      return;
    case 'End':
      moveTo(items[items.length - 1]);
      return;
    case 'ArrowRight': {
      const expandable = expandableFor(item);
      if (!expandable) return;
      event.preventDefault();
      if (expandable.getAttribute('aria-expanded') === 'false') {
        expandable.click();
        refocus(item);
      } else if (expandable === item) {
        moveTo(items[index + 1]);
      }
      return;
    }
    case 'ArrowLeft': {
      const expandable = expandableFor(item);
      if (expandable?.getAttribute('aria-expanded') === 'true') {
        event.preventDefault();
        expandable.click();
        refocus(item);
        return;
      }
      const parent = parentItem(item);
      if (parent) moveTo(parent);
      return;
    }
    case 'Enter': {
      event.preventDefault();
      releaseCursorHold?.();
      releaseSwitchCursorHold();
      item.click();
      const intoWork = () => {
        focusMainArea();
        // A chat that is still loading takes focus into its message box once it shows (D-328).
        const chat = chatShownInFocusedSplit();
        if (chat !== null) focusChatSoon(chat);
      };
      // A toggle (a project or section) stays in the list; a row opens its work.
      if (item.hasAttribute('aria-expanded')) { refocus(item); return; }
      // A row on another machine: the cursor stays in the list until the switch lands (D-6).
      const switching = machineSwitchInFlight();
      if (switching) {
        holdCursorThroughSwitch({
          switching,
          cursor: () => sidebarCursor,
          findByKey: key => document.querySelector<HTMLElement>(`[data-sidebar-key="${CSS.escape(key)}"]`),
          onLanded: () => requestAnimationFrame(() => requestAnimationFrame(intoWork)),
        });
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(intoWork));
      return;
    }
    case ' ':
      event.preventDefault();
      holdSidebarCursor();
      item.click();
      refocus(item);
      return;
    case 'Escape': {
      // In Approvals, Esc goes back to where you were before Approvals (D-251).
      if (useNavigationStore.getState().activeView === 'notify') return;
      event.preventDefault();
      releaseCursorHold?.();
      releaseSwitchCursorHold();
      const back = returnTarget;
      if (back?.isConnected && regionOf(back) !== 'sidebar') back.focus({ preventScroll: true });
      else focusMainArea();
      return;
    }
    default: {
      // Typing on another machine's Session row starts its message (T-132): the key goes into that
      // Session's box, which takes focus, and the Session engages there.
      const machineId = item.getAttribute(SESSION_CURSOR_MACHINE_ATTRIBUTE);
      const sessionId = item.getAttribute(SESSION_CURSOR_ATTRIBUTE);
      if (event.key.length === 1 && cursorFollowEnabled() && sessionId && machineId && machineId !== windowMachineId()) {
        event.preventDefault();
        const target = { machineId, sessionId };
        holdRemoteText(target, (useRemoteEngage.getState().held[engageKey(target)]?.text ?? '') + event.key);
        engageRemoteSession(target, 'type');
        return;
      }
      // Typing on the row settles what the cursor shows (T-87); the key keeps its own meaning.
      if (event.key.length === 1 && pendingCursorSession()) settleSessionCursor();
    }
  }
}

// A switch a 1 s rest started keeps the cursor in the list as Enter's does (D-6), and leaves it
// there when it lands: the person was only looking (T-132).
onEngageSwitch((cause) => {
  if (cause !== 'rest') return;
  const switching = machineSwitchInFlight();
  if (!switching || !sidebarCursor?.isConnected || document.activeElement !== sidebarCursor) return;
  holdCursorThroughSwitch({
    switching,
    cursor: () => sidebarCursor,
    findByKey: key => document.querySelector<HTMLElement>(`[data-sidebar-key="${CSS.escape(key)}"]`),
    onLanded: () => undefined,
  });
});

// --- Enter goes to the chat (D-328) ---

/** Where Enter has a meaning of its own: fields, terminals, buttons, links, tabs, rows of a list. */
const OWNS_ENTER = [
  'input', 'textarea', 'select', 'button', 'a[href]', 'summary', 'webview', '.xterm',
  '[contenteditable]:not([contenteditable="false"])',
  ...['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'combobox', 'textbox',
    'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell', 'row'].map(role => `[role="${role}"]`),
].join(', ');
/** Menus, pickers and dialogs: Enter there is theirs, as is everything inside them. */
const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const OVERLAY = `${DIALOG}, [role="menu"], [role="listbox"], [role="tree"], [role="grid"]`;

/** The message box of one chat tab, by its panel id. */
function composerOf(panelId: string): HTMLElement | null {
  return queryShown(`[data-focus-region="main"] [data-chat-composer="${CSS.escape(panelId)}"]`)[0] ?? null;
}

/**
 * The chat's message box on screen: the focused split's. Another split's chat
 * is never chosen while a split has focus; only a view without splits falls
 * back to the first chat in the main area.
 */
function chatComposerOnScreen(): HTMLElement | null {
  if (inMainArea(FOCUSED_SPLIT).length > 0) return inMainArea(`${FOCUSED_SPLIT} ${CHAT_COMPOSER}`)[0] ?? null;
  return inMainArea(CHAT_COMPOSER)[0] ?? null;
}

/**
 * Whether the focused split's selected tab is a chat: its panel id when it is,
 * null when it is something else, undefined when the tabs are not shown yet.
 */
function chatShownInFocusedSplit(): string | null | undefined {
  const tab = inMainArea(`${FOCUSED_SPLIT} [role="tab"][aria-selected="true"][data-panel-id]`)[0];
  if (!tab) return undefined;
  return tab.getAttribute('data-panel-type') === 'chat' ? tab.getAttribute('data-panel-id') : null;
}

/**
 * Enter with focus on no control (the page, a split, a region) moves focus
 * into the chat's message box when a chat tab is on screen (D-328). Enter in
 * a field, terminal, button, tab, menu, picker or dialog keeps its meaning.
 */
export function handleEnterToChat(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.repeat) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const target = event.target instanceof HTMLElement && event.target !== document.body ? event.target : null;
  if (target && (target.closest(OWNS_ENTER) || target.closest(OVERLAY))) return;
  // Focus in Approvals (the view, or a Session's approval column) stays there.
  if (regionOf(target) === 'approvals') return;
  if (queryShown('[aria-modal="true"]').length > 0) return;
  const box = chatComposerOnScreen();
  if (!box) return;
  event.preventDefault();
  releaseCursorHold?.();
  box.focus({ preventScroll: true });
}

/** How long Enter keeps steering focus into a chat that is loading or settling. */
const CHAT_WAIT_MS = 3000;
let cancelChatWait: (() => void) | null = null;

/**
 * After Enter opens something (a Pane from the sidebar, a chat tab), focus goes
 * into its chat's message box as soon as the chat shows, and stays there
 * while the view settles: a Pane that opens hands focus to a scroll surface
 * (its commit history) when its main tab has none of its own. Given a panel
 * id, only that chat's box is taken, never another split's. The wait ends on
 * a click, a key, or focus moving to a control, terminal or the sidebar. At
 * launch (`untilInput`) nobody has acted yet, so only a click, a key or a
 * dialog ends it: focus the opening Pane moves itself (its changes list) is
 * taken back.
 */
export function focusChatSoon(panelId?: string, { untilInput = false }: { untilInput?: boolean } = {}): void {
  cancelChatWait?.();
  const landed = document.activeElement;
  // Focus on no control (the page, a region, a scroll surface) is still free to move.
  const isFree = (element: Element | null) => !element || element === document.body || element === landed
    || (untilInput ? !element.closest(DIALOG) : regionOf(element) !== 'sidebar' && !element.closest(OWNS_ENTER) && !element.closest(OVERLAY));
  const target = () => (panelId ? composerOf(panelId) : chatComposerOnScreen());
  let box: HTMLElement | null = null;
  let frame = 0;
  const attempt = () => {
    frame = 0;
    const active = document.activeElement;
    if (box?.isConnected && active === box) return;
    // The launch outline's message box hands its focus to the chat itself (utils/launchOutline.ts).
    if (active?.closest('#pane-launch-outline')) return;
    if (!isFree(active)) { cancel(); return; }
    box = target();
    box?.focus({ preventScroll: true });
  };
  // DOM changes and focus moves are read once per frame, not on every mutation.
  const soon = () => { if (!frame) frame = requestAnimationFrame(attempt); };
  const observer = new MutationObserver(soon);
  const cancel = () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    window.removeEventListener('focusin', soon, true);
    window.removeEventListener('mousedown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
    clearTimeout(timer);
    if (cancelChatWait === cancel) cancelChatWait = null;
  };
  const timer = setTimeout(cancel, CHAT_WAIT_MS);
  // The body, not the main area: the Pane being opened may not have mounted its main area yet.
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('focusin', soon, true);
  window.addEventListener('mousedown', cancel, true);
  window.addEventListener('keydown', cancel, true);
  cancelChatWait = cancel;
  attempt();
}
