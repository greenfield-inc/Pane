/**
 * Pane's find for any container of rendered content: a chat, a file preview,
 * an approval's column (Decide, its Summary frame, a web or text reference)
 * and the Approvals screen around it. Each search goes to what is shown now:
 * - a Summary frame (`data-find-frame`): the page text inside the frame,
 *   highlighted with the frame's own highlight registry;
 * - a web or HTML reference (`data-find-webview`): the page's find-in-page;
 * - anything else: the surface's rendered page text, like a file preview.
 */
import { useEffect, useState, type RefObject } from 'react';
import { createBrowserFindAdapter, type FindableWebview } from '../panels/browser/browserFind';
import { refreshFind, reportFindResult, useFindBarOpen, type FindAdapter, type FindMode } from './findController';
import { createPageTextAdapter, watchFindMode } from './pageTextFinder';
import { usePanelFind } from './usePanelFind';

export const FIND_FRAME_ATTRIBUTE = 'data-find-frame';
export const FIND_WEBVIEW_ATTRIBUTE = 'data-find-webview';
const FRAME_STYLE_ATTRIBUTE = 'data-pane-find-style';
/** Re-check what the surface shows this long after it stops changing. */
const SWITCH_DELAY_MS = 150;

type SourceKind = 'page' | 'frame' | 'web';

interface FoundInPageEvent extends Event {
  result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean };
}

function shown<E extends Element = HTMLElement>(root: Element, attribute: string): E | null {
  const element = root.querySelector<E>(`[${attribute}]`);
  return element && element.getClientRects().length > 0 ? element : null;
}

function sourceOf(root: Element | null): SourceKind {
  if (!root) return 'page';
  if (shown(root, FIND_FRAME_ATTRIBUTE)) return 'frame';
  if (shown(root, FIND_WEBVIEW_ATTRIBUTE)) return 'web';
  return 'page';
}

/** The Summary frame's body, or null while it has none Pane may read. */
function frameBody(root: Element | null): HTMLElement | null {
  const frame = root ? shown(root, FIND_FRAME_ATTRIBUTE) : null;
  if (!(frame instanceof HTMLIFrameElement)) return null;
  try {
    return frame.contentDocument?.body ?? null;
  } catch {
    return null;
  }
}

// Webviews whose dom-ready has fired: find-in-page throws before it.
const readyWebviews = new WeakSet<Element>();

export function markWebviewReady(webview: Element): void {
  readyWebviews.add(webview);
}

function createSurfaceFindAdapter(findId: string, getRoot: () => HTMLElement | null): FindAdapter & { dispose(): void } {
  const page = createPageTextAdapter(findId, getRoot);
  const frame = createPageTextAdapter(findId, () => frameBody(getRoot()));
  const webviewOf = () => {
    const root = getRoot();
    // Elements marked data-find-webview are Electron <webview> tags (AutopilotWebPage).
    return root ? shown<Electron.WebviewTag>(root, FIND_WEBVIEW_ATTRIBUTE) : null;
  };
  const web = createBrowserFindAdapter({
    getWebview: (): FindableWebview | null => webviewOf(),
    isReady: () => {
      const webview = webviewOf();
      return !!webview && readyWebviews.has(webview);
    },
    hasPage: () => true,
    report: result => reportFindResult(findId, result),
    findInputHasFocus: () => document.activeElement instanceof HTMLElement && document.activeElement.dataset.findInput === findId,
    focusFindInput: () => document.querySelector<HTMLInputElement>(`[data-find-input="${CSS.escape(findId)}"]`)?.focus(),
  });
  const adapters = { page, frame, web } satisfies Record<SourceKind, FindAdapter>;

  let active: SourceKind | null = null;
  let listening: Element | null = null;
  let watcher: MutationObserver | null = null;
  let switchTimer: ReturnType<typeof setTimeout> | null = null;

  const onFound = (event: Event) => {
    // SAFETY: only found-in-page events are listened for here.
    web.handleFoundInPage((event as FoundInPageEvent).result);
  };
  const listenTo = (webview: Element | null) => {
    if (listening === webview) return;
    listening?.removeEventListener('found-in-page', onFound);
    listening = webview;
    listening?.addEventListener('found-in-page', onFound);
  };

  const stopWatching = () => {
    watcher?.disconnect();
    watcher = null;
    if (switchTimer) clearTimeout(switchTimer);
    switchTimer = null;
  };

  // Switching tab (Decide to Summary to a reference) changes what is searched: search again.
  const watch = (root: HTMLElement) => {
    if (watcher) return;
    watcher = new MutationObserver(() => {
      if (switchTimer) clearTimeout(switchTimer);
      switchTimer = setTimeout(() => {
        switchTimer = null;
        if (sourceOf(getRoot()) !== active) refreshFind(findId);
      }, SWITCH_DELAY_MS);
    });
    watcher.observe(root, { childList: true, subtree: true });
  };

  const clear = () => {
    stopWatching();
    listenTo(null);
    for (const adapter of Object.values(adapters)) adapter.clear();
    active = null;
  };

  return {
    mode(): FindMode {
      const root = getRoot();
      const kind = sourceOf(root);
      if (kind === 'frame') return frameBody(root) ? 'text' : 'none';
      if (kind === 'web') return 'text';
      return page.mode();
    },
    search(query) {
      const root = getRoot();
      const kind = sourceOf(root);
      if (active && active !== kind) adapters[active].clear();
      active = kind;
      if (kind === 'web') listenTo(webviewOf());
      else listenTo(null);
      if (root) watch(root);
      return adapters[kind].search(query);
    },
    step(direction) {
      return adapters[active ?? sourceOf(getRoot())].step(direction);
    },
    clear,
    selectedText() {
      return adapters[sourceOf(getRoot())].selectedText?.() ?? '';
    },
    restoreFocus() {
      getRoot()?.focus({ preventScroll: true });
    },
    dispose: clear,
  };
}

/**
 * Make a container searchable with Pane's find: the one way to do it for
 * rendered content (a terminal, a log or a browser tab brings its own adapter
 * to `usePanelFind`). `enabled: false` leaves it to a surface around it (the
 * Approvals screen searches its column itself).
 */
export function useSurfaceFind(findId: string, rootRef: RefObject<HTMLElement | null>, enabled = true): void {
  const [adapter] = useState(() => createSurfaceFindAdapter(findId, () => rootRef.current));
  useEffect(() => () => adapter.dispose(), [adapter]);
  usePanelFind(findId, rootRef, enabled ? adapter : null);

  const open = useFindBarOpen(findId);
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !open || !root) return;
    return watchFindMode(findId, root);
  }, [enabled, open, findId, rootRef]);
}

/** A theme token as a colour the frame can use (it can't resolve Pane's variables). */
function tokenColor(name: string, fallback: string): string {
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  probe.style.color = fallback;
  probe.style.color = `var(${name})`;
  const color = getComputedStyle(probe).color || fallback;
  probe.remove();
  return color;
}

/**
 * A Summary frame finished loading: give it Pane's match colours, and send
 * Pane's keys (⌘F, ⌘G and the rest) pressed inside it on to Pane. The frame
 * runs no scripts of its own; Pane reads it as the same origin.
 */
export function prepareFindFrame(frame: HTMLIFrameElement): void {
  let doc: Document | null = null;
  try {
    doc = frame.contentDocument;
  } catch {
    return;
  }
  if (!doc?.documentElement || doc.documentElement.hasAttribute(FRAME_STYLE_ATTRIBUTE)) return;
  doc.documentElement.setAttribute(FRAME_STYLE_ATTRIBUTE, '');
  const warning = tokenColor('--color-status-warning', 'rgb(217 119 6)');
  const onWarning = tokenColor('--color-text-on-status-warning', 'rgb(255 255 255)');
  const style = doc.createElement('style');
  style.setAttribute(FRAME_STYLE_ATTRIBUTE, '');
  style.textContent = `::highlight(pane-find-match){background-color:color-mix(in srgb, ${warning} 35%, transparent)}`
    + `::highlight(pane-find-current){background-color:${warning};color:${onWarning}}`;
  (doc.head ?? doc.documentElement).appendChild(style);
  doc.addEventListener('keydown', (event) => {
    if (!event.metaKey && !event.ctrlKey) return;
    const forwarded = new KeyboardEvent('keydown', {
      key: event.key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
      altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, bubbles: true, cancelable: true,
    });
    if (!frame.dispatchEvent(forwarded)) event.preventDefault();
  });
}

/** The Approvals screen searches its list and its open approval as one. */
export const APPROVALS_SCREEN_FIND_ID = 'approvals-screen';

/** The find id of an approval column on `surface` (the Approvals screen's column shares the screen's). */
export function approvalFindId(surface: string): string {
  return surface === 'approvals' ? APPROVALS_SCREEN_FIND_ID : `approval:${surface}`;
}
