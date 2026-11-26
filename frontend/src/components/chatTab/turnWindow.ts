import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { ChatTurn } from '../../../../shared/chatTabPresentation';

/**
 * The chat's turn window (T-87 Phase 2): only the turns on screen, and about a screen
 * above and below, are rendered; the rest are two spacers of their measured (or
 * estimated) height. Find (⌘F) renders every turn while its bar is open, since it
 * searches the rendered page.
 *
 * It writes the viewport's scroll position in three cases only, so it never fights
 * assistant-ui's follow-the-live-end or Pane's paging anchor (useWindowAnchor):
 * - restoring a chat's place as it mounts, before paint;
 * - keeping the reader's place when a turn above the viewport changes height
 *   (a spacer's estimate became a measured turn, or the turn re-rendered taller);
 * - never while the chat follows its live end: assistant-ui scrolls to the bottom then.
 */

/** Rows of a range: `start` included, `end` excluded. */
export interface TurnRange { start: number; end: number }

/** How far past each edge of the viewport turns stay rendered, in px. */
const OVERSCAN_PX = 800;
/** The gap above every turn but the first (the column's 24 px gap and the turn's 14 px margin before windowing). */
const TURN_GAP_PX = 38;

/** The turns whose rows cross [top - overscan, top + height + overscan), measured from the list's top. */
export function visibleRange(sizes: readonly number[], top: number, height: number, overscan = OVERSCAN_PX): TurnRange {
  const from = top - overscan;
  const to = top + height + overscan;
  let offset = 0;
  let start = sizes.length;
  let end = sizes.length;
  for (let index = 0; index < sizes.length; index++) {
    const next = offset + sizes[index];
    if (start === sizes.length && next > from) start = index;
    if (offset >= to) { end = index; break; }
    offset = next;
  }
  if (start > end) start = end;
  // Above the list's top (the Earlier button) or below its end (the notice), keep one turn.
  if (start === end && sizes.length) return start >= sizes.length ? { start: sizes.length - 1, end: sizes.length } : { start, end: start + 1 };
  return { start, end };
}

/** The last turns that fill `height + overscan`: a chat opening at its live end. */
export function endRange(sizes: readonly number[], height: number, overscan = OVERSCAN_PX): TurnRange {
  let filled = 0;
  let start = sizes.length;
  while (start > 0 && filled < height + overscan) filled += sizes[--start];
  return { start, end: sizes.length };
}

/** Whether `range` already shows every turn of `visible`, and not far more than `wanted`. */
export function rangeHolds(range: TurnRange, visible: TurnRange, wanted: TurnRange): boolean {
  const covers = range.start <= visible.start && range.end >= visible.end;
  const slack = 2 * Math.max(wanted.end - wanted.start, 1);
  return covers && range.end - range.start <= slack;
}

/**
 * The same turns after the list changed (a page loaded, a turn arrived, the window
 * trimmed): the rows rendered before stay rendered, so a paging anchor still finds them.
 * A turn whose key changed (an earlier page merged into the first turn) is the one
 * just before the first key still there, so the range widens by one at a missing edge.
 * A range that reached the last turn keeps reaching it, so a turn arriving at the live end renders at once.
 * Null when none of the rendered turns is left.
 */
export function remapRange(previousKeys: readonly string[], range: TurnRange, keys: readonly string[]): TurnRange | null {
  if (!keys.length) return { start: 0, end: 0 };
  const index = new Map(keys.map((key, position) => [key, position]));
  const kept = previousKeys.slice(range.start, range.end).flatMap(key => index.get(key) ?? []);
  if (!kept.length) return null;
  const first = index.get(previousKeys[range.start] ?? '');
  const last = index.get(previousKeys[range.end - 1] ?? '');
  const start = first ?? Math.max(0, Math.min(...kept) - 1);
  const end = range.end >= previousKeys.length ? keys.length : last !== undefined ? last + 1 : Math.min(keys.length, Math.max(...kept) + 2);
  return { start: Math.min(start, end), end };
}

/** Estimates by turn: chatTurns hands back the same object for a turn that did not change. */
const estimates = new WeakMap<ChatTurn, number>();

/** A first guess at a turn's height before it has rendered: its text in lines, plus the fold row. */
function estimateTurnHeight(turn: ChatTurn): number {
  let estimate = estimates.get(turn);
  if (estimate === undefined) { estimate = guessTurnHeight(turn); estimates.set(turn, estimate); }
  return estimate;
}

function guessTurnHeight(turn: ChatTurn): number {
  let lines = 0;
  const count = (text: string) => { for (const paragraph of text.split('\n')) lines += Math.max(1, Math.ceil(paragraph.length / 90)); };
  for (const part of turn.user?.parts ?? []) if (part.type === 'text') count(part.text);
  for (const item of turn.items) if (item.type === 'text') count(item.text);
  const fold = turn.items.some(item => item.type === 'steps' || item.type === 'thought') ? 32 : 0;
  return Math.min(4000, 24 + lines * 22 + fold + (turn.user ? 24 : 0));
}

/** Where a chat was left: the first turn on screen and how far into it the viewport's top was. */
interface ChatPlace { key: string; into: number }
interface ChatMemory { heights: Map<string, number>; place?: ChatPlace; atEnd: boolean; height: number }
/** Chats remembered at once; the oldest is forgotten first. */
const REMEMBERED = 100;
/** Measured turns kept per chat; the least recently measured go first, so paging a long chat can't grow it without end. */
const HEIGHTS_PER_CHAT = 2000;
const memories = new Map<string, ChatMemory>();

function memoryOf(chatId: string): ChatMemory {
  let memory = memories.get(chatId);
  if (memory) memories.delete(chatId);
  else memory = { heights: new Map(), atEnd: true, height: 0 };
  memories.set(chatId, memory);
  while (memories.size > REMEMBERED) memories.delete(memories.keys().next().value!);
  return memory;
}

/** Whether this chat was left away from its live end, so it mounts paged (before the window hook runs). */
export function leftAway(chatId: string): boolean {
  const memory = memories.get(chatId);
  return !!memory && !memory.atEnd && !!memory.place;
}

interface TurnWindowOptions {
  /** One per chat: places and measured heights are remembered under it. */
  chatId: string;
  turns: readonly ChatTurn[];
  viewportRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLElement | null>;
  /** Every turn renders (find is open). */
  all: boolean;
  /** The chat follows its live end now (autoScroll). */
  follows: boolean;
}

/** The range, widened to keep `focused` rendered: a focused control never unmounts under the keyboard. */
export function keepFocused(range: TurnRange, focused: number | undefined): TurnRange {
  if (focused === undefined || (focused >= range.start && focused < range.end)) return range;
  return focused < range.start ? { start: focused, end: range.end } : { start: range.start, end: focused + 1 };
}

export interface TurnWindow {
  range: TurnRange;
  /** Spacer heights above and below the rendered turns. */
  before: number;
  after: number;
  /** The chat mounted away from its live end: it starts paged, and assistant-ui must not scroll it to the bottom. */
  restoredAway: boolean;
}

const sizesOf = (turns: readonly ChatTurn[], heights: Map<string, number>) =>
  turns.map((turn, index) => heights.get(turn.id) ?? estimateTurnHeight(turn) + (index > 0 ? TURN_GAP_PX : 0));
const sum = (sizes: readonly number[], from: number, to: number) => { let total = 0; for (let index = from; index < to; index++) total += sizes[index]; return total; };

export function useTurnWindow({ chatId, turns, viewportRef, listRef, all, follows }: TurnWindowOptions): TurnWindow {
  const [restoredAway] = useState(() => leftAway(chatId));
  const memory = useState(() => memoryOf(chatId))[0];
  const keys = turns.map(turn => turn.id);
  const sizes = sizesOf(turns, memory.heights);

  /** The first range for a list: where the chat was left, or its live end. */
  const placed = (): TurnRange => {
    const height = memory.height || window.innerHeight;
    const at = restoredAway && memory.place ? keys.indexOf(memory.place.key) : -1;
    if (at < 0) return endRange(sizes, height);
    return visibleRange(sizes, sum(sizes, 0, at) + memory.place!.into, height);
  };
  const [state, setState] = useState(() => ({ keys, range: placed() }));
  let range = state.range;
  if (state.keys.join('\n') !== keys.join('\n')) {
    range = (state.keys.length ? remapRange(state.keys, state.range, keys) : null) ?? placed();
    setState({ keys, range });
  }
  const shown = all ? { start: 0, end: keys.length } : range;

  // What the listeners read: this commit's, published in the first layout effect below (a render React drops never reaches them).
  const live = useRef({ keys, sizes, shown, follows, all });
  const restored = useRef(false);
  const observed = useRef<{ observer: ResizeObserver; rows: Set<Element> } | null>(null);

  /** The list's top in the viewport's scroll coordinates. */
  const listTop = (viewport: HTMLElement, list: HTMLElement) => list.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
  /** Measures the rendered turns; a change above the viewport's top moves the scroll by as much, unless the chat follows its end. */
  const measure = (viewport: HTMLElement, list: HTMLElement) => {
    const top = viewport.getBoundingClientRect().top;
    const current = live.current.sizes;
    let shift = 0;
    for (const row of list.children) {
      if (!(row instanceof HTMLElement) || row.dataset.turnKey === undefined) continue;
      const rect = row.getBoundingClientRect();
      const index = Number(row.dataset.turnIndex);
      const was = current[index];
      if (was === undefined || Math.abs(was - rect.height) < 0.5) continue;
      memory.heights.delete(row.dataset.turnKey);
      memory.heights.set(row.dataset.turnKey, rect.height);
      current[index] = rect.height;
      // Only a turn wholly above the viewport moves what the reader sees; one crossing its top grew where the reader may be looking (a disclosure just opened).
      if (rect.bottom <= top + 0.5) shift += rect.height - was;
    }
    while (memory.heights.size > HEIGHTS_PER_CHAT) memory.heights.delete(memory.heights.keys().next().value!);
    if (shift && restored.current && !(live.current.follows && memory.atEnd)) viewport.scrollTop += shift;
  };
  /** Where the reader is. Whether they are at the live end is read only from scrolling: content growing is not the reader leaving. */
  const remember = (viewport: HTMLElement, list: HTMLElement, scrolled: boolean) => {
    const { sizes: current, keys: currentKeys, follows: following } = live.current;
    memory.height = viewport.clientHeight;
    if (scrolled) memory.atEnd = following && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 4;
    let offset = viewport.scrollTop - listTop(viewport, list);
    let index = 0;
    while (index < current.length - 1 && offset >= current[index]) offset -= current[index++];
    memory.place = current.length ? { key: currentKeys[index], into: offset } : undefined;
  };
  /** Re-picks the range for the scroll position; `urgent` renders now when turns on screen are missing. */
  const update = (viewport: HTMLElement, list: HTMLElement, urgent: boolean) => {
    const { sizes: current, shown: now, all: every } = live.current;
    if (every) return;
    const top = viewport.scrollTop - listTop(viewport, list);
    const visible = visibleRange(current, top, viewport.clientHeight, 0);
    const focusedRow = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('[data-turn-index]') : null;
    const wanted = keepFocused(visibleRange(current, top, viewport.clientHeight), focusedRow ? Number(focusedRow.dataset.turnIndex) : undefined);
    if (rangeHolds(now, visible, wanted)) return;
    const next = () => setState(previous => ({ ...previous, range: wanted }));
    if (urgent && (visible.start < now.start || visible.end > now.end)) flushSync(next);
    else next();
  };
  const handlers = useRef({ listTop, measure, remember, update });

  // First: publish this commit's data and handlers to the listeners.
  useLayoutEffect(() => {
    live.current = { keys, sizes, shown, follows, all };
    handlers.current = { listTop, measure, remember, update };
  });

  // Scrolling and resizing, for the viewport's lifetime.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const step = (urgent: boolean, scrolled: boolean) => {
      const list = listRef.current;
      if (!list) return;
      if (!scrolled) handlers.current.measure(viewport, list);
      handlers.current.update(viewport, list, urgent);
      handlers.current.remember(viewport, list, scrolled);
    };
    const onScroll = () => step(true, true);
    // A grown viewport (or a turn that shrank) can expose a spacer: render the turns now, before that frame paints.
    const observer = new ResizeObserver(() => step(true, false));
    observer.observe(viewport);
    observed.current = { observer, rows: new Set() };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    // Focus leaving a turn kept for it lets the window let go of that turn, once focus has landed.
    let frame = 0;
    const onFocusOut = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => step(false, false)); };
    viewport.addEventListener('focusout', onFocusOut);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('focusout', onFocusOut);
      viewport.removeEventListener('scroll', onScroll);
      observer.disconnect();
      observed.current = null;
    };
  }, [viewportRef, listRef]);

  // Every commit: watch the rows now rendered (and only those), measure them, restore the place once.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const list = listRef.current;
    if (!viewport || !list) return;
    const watch = observed.current;
    if (watch) {
      const rows = new Set([...list.children].filter(row => row instanceof HTMLElement && row.dataset.turnKey !== undefined));
      for (const row of watch.rows) if (!rows.has(row)) watch.observer.unobserve(row);
      for (const row of rows) if (!watch.rows.has(row)) watch.observer.observe(row);
      watch.rows = rows;
    }
    const { measure: measureRows, update: pick, remember: keep, listTop: topOf } = handlers.current;
    measureRows(viewport, list);
    if (!restored.current && live.current.keys.length) {
      restored.current = true;
      const at = restoredAway && memory.place ? live.current.keys.indexOf(memory.place.key) : -1;
      // The turn it was left at is not in this window (the viewer drops an older page as the chat closes): back to the live end, following it.
      if (at < 0) memory.atEnd = true;
      viewport.scrollTop = at >= 0 ? topOf(viewport, list) + sum(live.current.sizes, 0, at) + memory.place!.into : viewport.scrollHeight;
    }
    pick(viewport, list, false);
    keep(viewport, list, false);
  });

  return { range: shown, before: sum(sizes, 0, shown.start), after: sum(sizes, shown.end, sizes.length), restoredAway };
}
