/**
 * Pane's find: one bar per tab, driven by a small adapter each searchable tab
 * provides (terminal, browser, file preview, Logs). The router
 * (useFindHotkeys) decides which tab gets Cmd/Ctrl+F; this module keeps each
 * tab's bar state and calls its adapter.
 */
import { create } from 'zustand';

/**
 * - `text`: the tab has text Pane can search.
 * - `none`: nothing to search (image, video, PDF…); the bar says so.
 * - `native`: the tab has its own find (Monaco); Pane's bar stays out of the way.
 */
export type FindMode = 'text' | 'none' | 'native';

export interface FindResult {
  /** 1-based index of the current match; 0 when there is none. */
  current: number;
  total: number;
}

export interface FindAdapter {
  mode(): FindMode;
  /** Highlight every match and make the first one current. Async adapters return nothing and call reportFindResult. */
  search(query: string): FindResult | void;
  step(direction: 'next' | 'prev'): FindResult | void;
  /** Remove every highlight. */
  clear(): void;
  /** Text selected in the tab, used to start the query. */
  selectedText?(): string;
  /** Put keyboard focus back in the tab's content after the bar closes. */
  restoreFocus?(): void;
}

export interface FindTarget {
  adapter: FindAdapter;
  /** The tab's content element: focus or clicks inside it make this tab the find target. */
  root: () => Element | null;
}

export interface FindBarState {
  open: boolean;
  query: string;
  result: FindResult;
  noText: boolean;
  /** Bumped whenever the input should take focus and select its text. */
  focusRequest: number;
}

const EMPTY_RESULT: FindResult = { current: 0, total: 0 };
const CLOSED: FindBarState = { open: false, query: '', result: EMPTY_RESULT, noText: false, focusRequest: 0 };

interface FindStore {
  bars: Record<string, FindBarState>;
}

const useFindStore = create<FindStore>(() => ({ bars: {} }));

const targets = new Map<string, FindTarget>();

export function getFindBar(panelId: string): FindBarState {
  return useFindStore.getState().bars[panelId] ?? CLOSED;
}

export function useFindBar(panelId: string): FindBarState {
  return useFindStore((state) => state.bars[panelId] ?? CLOSED);
}

/** Whether the tab's bar is open, without re-rendering on every result. */
export function useFindBarOpen(panelId: string): boolean {
  return useFindStore((state) => state.bars[panelId]?.open ?? false);
}

function updateBar(panelId: string, patch: Partial<FindBarState>): void {
  useFindStore.setState((state) => ({
    bars: { ...state.bars, [panelId]: { ...(state.bars[panelId] ?? CLOSED), ...patch } },
  }));
}

function applyResult(panelId: string, result: FindResult | void): void {
  if (result) updateBar(panelId, { result });
}

export function reportFindResult(panelId: string, result: FindResult): void {
  if (!getFindBar(panelId).open) return;
  updateBar(panelId, { result });
}

export function getFindTarget(panelId: string): FindTarget | undefined {
  return targets.get(panelId);
}

export function getFindTargets(): ReadonlyMap<string, FindTarget> {
  return targets;
}

export function registerFindTarget(panelId: string, target: FindTarget): () => void {
  targets.set(panelId, target);
  // A tab that remounts (browser and editor tabs unmount when hidden) picks
  // its open search back up, or changes the bar to suit its new content.
  const bar = getFindBar(panelId);
  if (bar.open && bar.query && !bar.noText && target.adapter.mode() === 'text') {
    applyResult(panelId, target.adapter.search(bar.query));
  } else {
    syncFindMode(panelId);
  }
  return () => {
    if (targets.get(panelId) === target) targets.delete(panelId);
  };
}

/**
 * The tab's content changed what it offers (a preview switched to the code
 * editor, an image tab now shows text): fit the open bar to it. Monaco takes
 * over find, so Pane's bar closes; a tab with no text says so; text that
 * appears re-runs the remembered query.
 */
export function syncFindMode(panelId: string): void {
  const target = targets.get(panelId);
  const bar = getFindBar(panelId);
  if (!target || !bar.open) return;
  const mode = target.adapter.mode();
  if (mode === 'native') {
    target.adapter.clear();
    updateBar(panelId, { open: false, result: EMPTY_RESULT, noText: false });
    return;
  }
  if (mode === 'none') {
    if (bar.noText) return;
    target.adapter.clear();
    updateBar(panelId, { noText: true, result: EMPTY_RESULT });
    return;
  }
  if (!bar.noText) return;
  updateBar(panelId, { noText: false, result: EMPTY_RESULT });
  if (bar.query) applyResult(panelId, target.adapter.search(bar.query));
}

function seedFromSelection(adapter: FindAdapter): string | null {
  const selection = adapter.selectedText?.().trim() ?? '';
  if (!selection || /[\r\n]/.test(selection)) return null;
  return selection;
}

/**
 * Open (or refocus) the tab's bar. Returns false when the tab has no Pane find.
 * `seed: false` keeps the remembered query instead of the selected text.
 */
export function openFind(panelId: string, options: { seed?: boolean } = {}): boolean {
  const target = targets.get(panelId);
  if (!target) return false;
  const mode = target.adapter.mode();
  if (mode === 'native') return false;

  const bar = getFindBar(panelId);
  const noText = mode === 'none';
  const seed = noText || options.seed === false ? null : seedFromSelection(target.adapter);
  const query = seed ?? bar.query;
  const rerun = !noText && query !== '' && (!bar.open || seed !== null);
  updateBar(panelId, { open: true, query, noText, focusRequest: bar.focusRequest + 1 });
  if (rerun) applyResult(panelId, target.adapter.search(query));
  return true;
}

export function setFindQuery(panelId: string, query: string): void {
  const target = targets.get(panelId);
  const bar = getFindBar(panelId);
  updateBar(panelId, { query });
  if (!target || bar.noText) return;
  if (!query) {
    target.adapter.clear();
    updateBar(panelId, { result: EMPTY_RESULT });
    return;
  }
  applyResult(panelId, target.adapter.search(query));
}

/**
 * Cmd+G / Shift+Cmd+G. With the bar closed, reopens it on the last query
 * (not the selection) and moves once: Next to the second match, Previous to
 * the last, as a reopened search starts on the first.
 */
export function stepFind(panelId: string, direction: 'next' | 'prev'): boolean {
  const target = targets.get(panelId);
  if (!target) return false;
  const bar = getFindBar(panelId);
  if (!bar.open) {
    if (!bar.query || target.adapter.mode() !== 'text') return false;
    if (!openFind(panelId, { seed: false })) return false;
  }
  if (bar.noText || !bar.query) return true;
  applyResult(panelId, target.adapter.step(direction));
  return true;
}

export function closeFind(panelId: string): void {
  const bar = getFindBar(panelId);
  if (!bar.open) return;
  const target = targets.get(panelId);
  target?.adapter.clear();
  updateBar(panelId, { open: false, result: EMPTY_RESULT, noText: false });
  target?.adapter.restoreFocus?.();
}

export function resetFindForTests(): void {
  targets.clear();
  useFindStore.setState({ bars: {} });
}
