/**
 * Find adapter for a tab whose content is ordinary page text (markdown,
 * notebook, CSV/archive/SQLite tables, the single-file diff). Matches are
 * drawn with the CSS Custom Highlight API, so React-rendered content is
 * never rewritten.
 */
import { findInPrepared, prepareSegments, stepMatchIndex, type PreparedText, type TextMatch, type TextSegment } from './findText';
import { reportFindResult, syncFindMode, type FindAdapter, type FindMode, type FindResult } from './findController';

const MATCH_HIGHLIGHT = 'pane-find-match';
const CURRENT_HIGHLIGHT = 'pane-find-current';
/** Re-search this long after the content stops changing. */
const RERUN_DELAY_MS = 150;
/**
 * Highlight at most this many matches either side of the current one, plus
 * the matches on screen; the count still covers every match. Painting 100k
 * ranges (a one-letter query in a 1 MB file) would stall typing.
 */
const HIGHLIGHT_WINDOW = 500;
/** At most this many on-screen matches are painted beyond the window. */
const VISIBLE_LIMIT = 2000;

const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD',
  'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'LABEL',
]);
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'svg']);

/**
 * Elements a tab marks as having no text (image, video, audio, PDF, font,
 * binary notice); Pane's bar then says so (D-8).
 */
const FIND_EMPTY_ATTRIBUTE = 'data-find-empty';

// Every page-text tab contributes to the same two named highlights.
const highlightsByTab = new Map<string, { all: Range[]; current: Range | null }>();

function syncHighlights(): void {
  if (!('CSS' in globalThis) || !('highlights' in CSS)) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const entry of highlightsByTab.values()) {
    all.push(...entry.all);
    if (entry.current) current.push(entry.current);
  }
  if (all.length) CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...all));
  else CSS.highlights.delete(MATCH_HIGHLIGHT);
  if (current.length) {
    const highlight = new Highlight(...current);
    highlight.priority = 1;
    CSS.highlights.set(CURRENT_HIGHLIGHT, highlight);
  } else {
    CSS.highlights.delete(CURRENT_HIGHLIGHT);
  }
}

function pageTextFindMode(root: Element | null): FindMode {
  if (!root) return 'text';
  if (root.querySelector('.monaco-editor')) return 'native';
  if (root.querySelector(`[${FIND_EMPTY_ATTRIBUTE}]`)) return 'none';
  return 'text';
}

function blockOf(element: Element, root: Element, cache: Map<Element, Element>): Element {
  const cached = cache.get(element);
  if (cached) return cached;
  let block: Element = element;
  while (block !== root && INLINE_TAGS.has(block.tagName) && block.parentElement) block = block.parentElement;
  cache.set(element, block);
  return block;
}

function isRendered(element: Element, cache: Map<Element, boolean>): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  const rendered = 'checkVisibility' in element ? element.checkVisibility() : true;
  cache.set(element, rendered);
  return rendered;
}

interface CollectedText {
  nodes: Text[];
  segments: TextSegment[];
}

function collectPageText(root: Element): CollectedText {
  const nodes: Text[] = [];
  const segments: TextSegment[] = [];
  const blockCache = new Map<Element, Element>();
  const renderCache = new Map<Element, boolean>();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      // SAFETY: SHOW_ELEMENT | SHOW_TEXT yields only elements besides text nodes.
      const element = node as Element;
      if (SKIPPED_TAGS.has(element.tagName) || element.hasAttribute('data-find-bar') || element.getAttribute('aria-hidden') === 'true') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  let previousBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // SAFETY: the filter accepts only text nodes.
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || !text.data || !isRendered(parent, renderCache)) continue;
    const block = blockOf(parent, root, blockCache);
    segments.push({ text: text.data, breakBefore: previousBlock !== null && block !== previousBlock });
    nodes.push(text);
    previousBlock = block;
  }
  return { nodes, segments };
}

function isScrollable(element: Element): boolean {
  const style = getComputedStyle(element);
  return /(auto|scroll)/.test(style.overflowY + style.overflowX)
    && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
}

function scrollRangeIntoView(range: Range, root: Element): void {
  const rect = range.getBoundingClientRect();
  let container: Element | null = range.startContainer.parentElement;
  while (container && container !== root && !isScrollable(container)) container = container.parentElement;
  if (!container || !isScrollable(container)) return;
  const bounds = container.getBoundingClientRect();
  if (rect.top < bounds.top || rect.bottom > bounds.bottom) {
    container.scrollTop += rect.top - bounds.top - (bounds.height - rect.height) / 2;
  }
  if (rect.left < bounds.left || rect.right > bounds.right) {
    container.scrollLeft += rect.left - bounds.left - (bounds.width - rect.width) / 2;
  }
}

/**
 * While the tab's bar is open, fit it to content that switches mode (Preview
 * to Source puts Monaco in the tab; a reused tab swaps an image for text).
 * Returns a stop function.
 */
export function watchFindMode(panelId: string, root: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      syncFindMode(panelId);
    }, RERUN_DELAY_MS);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (timer) clearTimeout(timer);
  };
}

export interface PageTextAdapter extends FindAdapter {
  dispose(): void;
}

export function createPageTextAdapter(panelId: string, getRoot: () => HTMLElement | null): PageTextAdapter {
  let query = '';
  let matches: TextMatch[] = [];
  let current = 0;
  // The page text, collected once and reused until the content changes.
  let text: { root: HTMLElement; nodes: Text[]; prepared: PreparedText } | null = null;
  let observer: MutationObserver | null = null;
  let rerunTimer: ReturnType<typeof setTimeout> | null = null;
  // Match indexes painted now, as [from, to) intervals.
  let painted: Array<[number, number]> = [];
  let scrollRoot: HTMLElement | null = null;
  let scrollFrame: number | null = null;

  const result = (): FindResult => ({ current, total: matches.length });

  const toRange = (match: TextMatch): Range | null => {
    if (!text) return null;
    const start = text.nodes[match.start.segment];
    const end = text.nodes[match.end.segment];
    if (!start?.isConnected || !end?.isConnected) return null;
    const range = text.root.ownerDocument.createRange();
    range.setStart(start, match.start.offset);
    range.setEnd(end, match.end.offset);
    return range;
  };

  const rectOf = (index: number): DOMRect | null => toRange(matches[index])?.getBoundingClientRect() ?? null;

  /** The matches inside the tab's visible area, found by binary search (matches are in page order). */
  const visibleInterval = (): [number, number] | null => {
    if (!text || !matches.length) return null;
    const view = text.root.getBoundingClientRect();
    const top = Math.max(view.top, 0);
    const bottom = Math.min(view.bottom, text.root.ownerDocument.defaultView?.innerHeight ?? view.bottom);
    if (bottom <= top) return null;
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const rect = rectOf(mid);
      if (!rect || rect.bottom < top) low = mid + 1;
      else high = mid;
    }
    let end = low;
    while (end < matches.length && end - low < VISIBLE_LIMIT) {
      const rect = rectOf(end);
      if (rect && rect.top > bottom) break;
      end += 1;
    }
    return end > low ? [low, end] : null;
  };

  const isPainted = ([from, to]: [number, number]) => painted.some(([a, b]) => a <= from && to <= b);

  const paint = (scroll: boolean) => {
    if (!matches.length) {
      painted = [];
      highlightsByTab.delete(panelId);
      syncHighlights();
      return;
    }
    const center = Math.max(current - 1, 0);
    const around: [number, number] = [Math.max(0, center - HIGHLIGHT_WINDOW), Math.min(matches.length, center + HIGHLIGHT_WINDOW + 1)];
    const all: Range[] = [];
    let currentRange: Range | null = null;
    const addInterval = ([from, to]: [number, number], skip: [number, number] | null) => {
      for (let index = from; index < to; index += 1) {
        if (skip && index >= skip[0] && index < skip[1]) continue;
        const range = toRange(matches[index]);
        if (!range) continue;
        all.push(range);
        if (index === current - 1) currentRange = range;
      }
    };
    addInterval(around, null);
    painted = [around];
    if (scroll && current > 0) {
      // Typing and stepping scroll the current match into view, so what's on
      // screen is inside `around`; skip the on-screen scan (it forces layout).
      const currentMatch = toRange(matches[current - 1]);
      if (currentMatch && text) scrollRangeIntoView(currentMatch, text.root);
      highlightsByTab.set(panelId, { all, current: currentRange });
      syncHighlights();
      return;
    }
    const visible = visibleInterval();
    if (visible && !isPainted(visible)) {
      addInterval(visible, around);
      painted.push(visible);
    }
    highlightsByTab.set(panelId, { all, current: currentRange });
    syncHighlights();
  };

  // Scrolling by hand brings matches outside the window on screen: paint them.
  const onScroll = () => {
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      const visible = visibleInterval();
      if (visible && !isPainted(visible)) paint(false);
    });
  };

  const watchScroll = (root: HTMLElement) => {
    if (scrollRoot === root) return;
    unwatchScroll();
    scrollRoot = root;
    // Scroll events don't bubble; capture sees every scroller inside the tab.
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  };

  const unwatchScroll = () => {
    scrollRoot?.removeEventListener('scroll', onScroll, { capture: true });
    scrollRoot = null;
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  };

  const pageText = (root: HTMLElement) => {
    if (!text || text.root !== root) {
      const { nodes, segments } = collectPageText(root);
      text = { root, nodes, prepared: prepareSegments(segments) };
    }
    return text;
  };

  const stopObserving = () => {
    unwatchScroll();
    observer?.disconnect();
    observer = null;
    if (rerunTimer) clearTimeout(rerunTimer);
    rerunTimer = null;
  };

  // Previews re-render (a file reloads, a notebook output arrives): search again.
  const observe = (root: HTMLElement) => {
    if (observer) return;
    observer = new MutationObserver((records) => {
      if (records.every(record => record.target instanceof Element && record.target.closest('[data-find-bar]'))) return;
      text = null;
      if (rerunTimer) clearTimeout(rerunTimer);
      rerunTimer = setTimeout(() => {
        rerunTimer = null;
        const latest = getRoot();
        if (!query || !latest) return;
        // The tab now shows the code editor or a no-text preview: don't search it.
        if (pageTextFindMode(latest) !== 'text') {
          syncFindMode(panelId);
          return;
        }
        const previous = current;
        matches = findInPrepared(pageText(latest).prepared, query);
        current = matches.length ? Math.min(Math.max(previous, 1), matches.length) : 0;
        paint(false);
        reportFindResult(panelId, result());
      }, RERUN_DELAY_MS);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  };

  const clear = () => {
    query = '';
    matches = [];
    current = 0;
    text = null;
    stopObserving();
    paint(false);
  };

  return {
    mode: () => pageTextFindMode(getRoot()),
    search(nextQuery) {
      const root = getRoot();
      query = nextQuery;
      if (!root) {
        matches = [];
        current = 0;
        return result();
      }
      matches = findInPrepared(pageText(root).prepared, query);
      current = matches.length ? 1 : 0;
      paint(true);
      observe(root);
      watchScroll(root);
      return result();
    },
    step(direction) {
      current = stepMatchIndex(current, matches.length, direction);
      paint(true);
      return result();
    },
    clear,
    selectedText() {
      const root = getRoot();
      const selection = root?.ownerDocument.getSelection();
      if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) return '';
      return selection.toString();
    },
    restoreFocus() {
      getRoot()?.focus({ preventScroll: true });
    },
    dispose: clear,
  };
}
