// The home list (design list A, D-88; marks D-94): one list across every paired computer.
// Its first row starts a new Session by voice (D-89). Notify questions come next, then info cards, then every Session and Pane, newest activity first. Each row starts
// with its computer's mark and the first five letters of its name.
//
// The API other screens build on, kept small:
// - homeRows(computers, cards, unjoined, newOn): the merged rows, in order. Identity is `key` (computer + id).
// - homeListPage(rows, view, clock): the page that shows them, in the LIST_MARKS style.
// - outlineRowAt(rows, index): the row a native list press names (outline marks only).
import { BRIGHT, DIM, DIMMER, LIST_PAD, MAX_LIST_ITEMS, type Box, type Brightness, type ImageBox, type Page, type TextBox } from './display';
import { drawLogoStrip, type StripMark } from './logos';
import type { Card, Computer, MachineOs, PaneEntry, UnjoinedComputer } from './model';
import { SCREEN_H, SCREEN_W, fitLine, wrapClamped, LINE_H } from './text';

/**
 * How rows are marked. `logos`: the app draws its own list, with OS logos as images beside the
 * text (D-94). `outline`: the firmware list with one outline shape per computer and each away
 * computer folded into one row, the fallback if swipes on real G2 feel slow (G19).
 */
export type ListMarks = 'logos' | 'outline';
export const LIST_MARKS: ListMarks = 'logos';

interface RowBase {
  /** Unique across computers: the computer's id plus the row's own id. */
  key: string;
  computerId: string;
  /** The computer's name, such as "studio-mac". */
  machine: string;
  os: MachineOs | null;
  /** The computer's place in pairing order; the outline marks use it. */
  slot: number;
  /** Rows of a computer that isn't live dim and say why. */
  status: Computer['status'];
  lastSeenAt: number | null;
}

export type HomeRow =
  /** "+ New Session on studio-mac · hold to say it": hold, speak, release starts it there. */
  | (RowBase & { kind: 'new' })
  | (RowBase & { kind: 'question'; card: Card })
  /** An info card (ui `info`): a message with nothing to answer. */
  | (RowBase & { kind: 'info'; card: Card })
  | (RowBase & { kind: 'entry'; entry: PaneEntry })
  /**
   * A computer with nothing to list: one that is away and has no rows yet, or, with `reason`, one
   * of yours that couldn't join the glasses (the reason replaces the status text).
   */
  | (RowBase & { kind: 'computer'; reason?: string });

/** Whether a card asks about this entry, so the question row stands in for it. */
function asksAbout(card: Card, entry: PaneEntry): boolean {
  return (card.panelId !== undefined && card.panelId === entry.panelId) || (card.paneId !== undefined && card.paneId === entry.id);
}

/**
 * Every computer's rows merged, the way the cards merge: waiting questions first (in card order,
 * newest first), then info cards in card order, then every Session and Pane newest activity first,
 * then one row for each away computer with nothing to list, then one dim row for each computer that
 * couldn't join. A computer that goes away keeps its rows, marked by `status`.
 */
export function homeRows(computers: readonly Computer[], cards: readonly Card[], unjoined: readonly UnjoinedComputer[] = [], newOn?: Computer): HomeRow[] {
  const base = (computer: Computer, slot: number) => ({
    computerId: computer.id, machine: computer.name, os: computer.os, slot, status: computer.status, lastSeenAt: computer.lastSeenAt,
  });
  const slots = new Map(computers.map((computer, slot) => [computer.id, { computer, slot }]));
  const questions: HomeRow[] = [];
  const infos: HomeRow[] = [];
  for (const card of cards) {
    const found = slots.get(card.computerId);
    if (!found) continue;
    const row = { ...base(found.computer, found.slot), key: `${card.computerId}|card:${card.itemId}`, card };
    if (card.waiting) questions.push({ ...row, kind: 'question' });
    else infos.push({ ...row, kind: 'info' });
  }
  const entries: Array<HomeRow & { kind: 'entry' }> = [];
  const away: HomeRow[] = [];
  computers.forEach((computer, slot) => {
    const asked = cards.filter((card) => card.waiting && card.computerId === computer.id);
    for (const entry of computer.entries) {
      if (asked.some((card) => asksAbout(card, entry))) continue;
      entries.push({ ...base(computer, slot), kind: 'entry', key: `${computer.id}|${entry.kind}:${entry.id}`, entry });
    }
    if (computer.status !== 'live' && !computer.entries.length) away.push({ ...base(computer, slot), kind: 'computer', key: `${computer.id}|computer` });
  });
  // A stable sort keeps each computer's own order among rows with the same time.
  entries.sort((a, b) => (b.entry.activityAt ?? 0) - (a.entry.activityAt ?? 0));
  const outside = unjoined.map((computer, index): HomeRow => ({
    kind: 'computer', key: `unjoined|${computer.name}`, computerId: `unjoined|${computer.name}`, machine: computer.name, os: null,
    slot: computers.length + index, status: 'offline', lastSeenAt: null, reason: computer.reason,
  }));
  const found = newOn && slots.get(newOn.id);
  const start: HomeRow[] = found ? [{ ...base(found.computer, found.slot), kind: 'new', key: 'new' }] : [];
  return [...start, ...questions, ...infos, ...entries, ...away, ...outside];
}

/** What an away computer's rows say instead of their status. */
function awayText(row: HomeRow, clock: (epochMs: number) => string): string | null {
  switch (row.status) {
    case 'live': return null;
    case 'connecting': return 'connecting…';
    case 'refused': return 'refused · press for why';
    case 'offline': return row.lastSeenAt ? `offline since ${clock(row.lastSeenAt)}` : 'offline';
  }
}

/** The row's words after its mark and computer letters. */
function rowText(row: HomeRow, clock: (epochMs: number) => string): string {
  const away = awayText(row, clock);
  switch (row.kind) {
    case 'new':
      return `+ New Session on ${row.machine} · hold to say it`;
    case 'question':
      return `${row.card.paneName} · needs you`;
    case 'info':
      return `${row.card.paneName} · ${row.card.title}`;
    case 'entry': {
      const { entry } = row;
      if (away) return `${entry.name} · ${away}`;
      return entry.kind === 'session' ? `${entry.name} · Session · ${entry.status}` : `${entry.name} · ${entry.agent} · ${entry.status}`;
    }
    case 'computer':
      return `${row.machine} · ${row.reason ?? away ?? ''}`;
  }
}

/** The computer's first five letters; the new-Session row names its computer in full instead. */
const letters = (row: HomeRow) => (row.kind === 'new' ? '' : `${row.machine.slice(0, 5)}  `);

export interface HomeListView {
  /** The selected row's index in `rows` (logo marks; the firmware list keeps its own). */
  selected: number;
  /** Replaces the header, bright, such as "Answered fix-login: Stub the clock". */
  confirmation?: string;
  /** Overrides LIST_MARKS, for the dev gallery. */
  marks?: ListMarks;
}

const BAR_H = 32;
const ROW_H = 40;
/** Rows on one page of the logo list, and on each of its two logo strips. */
const PAGE_ROWS = 6;
const STRIP_ROWS = 3;
const STRIP_X = 4;
const STRIP_W = 28;
const TEXT_X = 34;
const ROW_PAD = 6;

function headerText(rows: readonly HomeRow[]): string {
  const waiting = rows.filter((row) => row.kind === 'question').length;
  return waiting ? `All computers · ${waiting} need${waiting === 1 ? 's' : ''} you` : 'All computers';
}

function header(rows: readonly HomeRow[], view: HomeListView): TextBox {
  const text = view.confirmation ?? headerText(rows);
  return { kind: 'text', name: 'header', x: 0, y: 0, w: SCREEN_W, h: BAR_H, pad: 2, lines: [fitLine(text, SCREEN_W - 8)], brightness: view.confirmation ? BRIGHT : DIM };
}

function emptyPage(rows: readonly HomeRow[], view: HomeListView): Page {
  const { lines } = wrapClamped('No open Sessions or Panes on your computers.', SCREEN_W - 20, Math.floor((SCREEN_H - BAR_H - 16) / LINE_H));
  return { boxes: [header(rows, view), { kind: 'text', name: 'body', x: 0, y: 36, w: SCREEN_W, h: 252, pad: 8, lines, brightness: BRIGHT, capture: true }] };
}

/**
 * The page that shows `rows`. Logo marks: six text rows with two logo strips (28 x 120 px, three
 * rows each) beside them. The layout never changes, so a swipe within a page rewrites only the
 * two rows that change; a page turn rewrites the rows and resends the strips.
 */
export function homeListPage(rows: readonly HomeRow[], view: HomeListView, clock: (epochMs: number) => string): Page {
  if (!rows.length) return emptyPage(rows, view);
  if ((view.marks ?? LIST_MARKS) === 'outline') return outlinePage(rows, view, clock);
  const selected = Math.max(0, Math.min(view.selected, rows.length - 1));
  const first = Math.floor(selected / PAGE_ROWS) * PAGE_ROWS;
  const shown = rows.slice(first, first + PAGE_ROWS);
  const boxes: Box[] = [header(rows, view)];
  for (let index = 0; index < PAGE_ROWS; index += 1) {
    const row = shown[index];
    const isSelected = first + index === selected;
    const brightness: Brightness = isSelected ? BRIGHT : row && row.status !== 'live' && row.kind !== 'new' ? DIMMER : DIM;
    const text = row ? `${isSelected ? '> ' : '   '}${letters(row)}${rowText(row, clock)}` : ' ';
    boxes.push({
      kind: 'text', name: `row${index}`, x: TEXT_X, y: BAR_H + index * ROW_H, w: SCREEN_W - TEXT_X, h: ROW_H, pad: ROW_PAD,
      lines: [fitLine(text, SCREEN_W - TEXT_X - 2 * ROW_PAD - 4)], brightness, capture: index === 0,
    });
  }
  for (let strip = 0; strip < PAGE_ROWS / STRIP_ROWS; strip += 1) {
    const marks: StripMark[] = shown.slice(strip * STRIP_ROWS, (strip + 1) * STRIP_ROWS)
      .map((row) => (row.kind === 'new' ? { os: null, dim: false, blank: true } : { os: row.os, dim: row.status !== 'live' }));
    boxes.push(logoStrip(`logos${strip}`, BAR_H + strip * STRIP_ROWS * ROW_H, marks));
  }
  return { boxes };
}

function logoStrip(name: string, y: number, marks: StripMark[]): ImageBox {
  return {
    kind: 'image', name, x: STRIP_X, y, w: STRIP_W, h: STRIP_ROWS * ROW_H,
    key: marks.map((mark) => (mark.blank ? 'blank' : `${mark.os ?? 'computer'}${mark.dim ? ':dim' : ''}`)).join(','),
    draw: () => drawLogoStrip(marks, { width: STRIP_W, height: STRIP_ROWS * ROW_H, rowHeight: ROW_H }),
  };
}

// ---------- outline marks (the fallback) ----------

/** Each computer's outline mark, by its place in pairing order. */
const OUTLINE_MARKS = ['○', '□', '△', '◇'] as const;

/** One firmware list row: a row, or a fold that stands for several. */
type OutlineItem = { row: HomeRow; text: string } | { row: null; text: string };

function outlineItems(rows: readonly HomeRow[], clock: (epochMs: number) => string): OutlineItem[] {
  const mark = (row: HomeRow) => `${OUTLINE_MARKS[row.slot % OUTLINE_MARKS.length]} ${letters(row)}`;
  const live = rows.filter((row) => row.status === 'live');
  // Each away computer folds into one row, at the end so it always shows.
  const away = new Map<string, { first: HomeRow; count: number }>();
  for (const row of rows) {
    if (row.status === 'live') continue;
    const group = away.get(row.computerId);
    if (group) group.count += 1;
    else away.set(row.computerId, { first: row, count: 1 });
  }
  const folded: OutlineItem[] = [...away.values()].map(({ first, count }) => {
    if (first.kind === 'computer') return { row: first, text: `${mark(first)}${rowText(first, clock)}` };
    const panes = count === 1 ? '1 Pane' : `${count} Panes`;
    return { row: first, text: `${mark(first)}${awayText(first, clock) ?? ''} · ${panes} · retry` };
  });
  const room = MAX_LIST_ITEMS - folded.length;
  const items: OutlineItem[] = live.map((row) => ({ row, text: `${mark(row)}${rowText(row, clock)}` }));
  // A list longer than the firmware shows folds its oldest rows, above the away computers.
  const kept = items.length > room ? [...items.slice(0, room - 1), { row: null, text: `· ${items.length - room + 1} older Panes ·` }] : items;
  return [...kept, ...folded];
}

function outlinePage(rows: readonly HomeRow[], view: HomeListView, clock: (epochMs: number) => string): Page {
  const items = outlineItems(rows, clock).map((item) => item.text);
  return {
    boxes: [
      header(rows, view),
      { kind: 'list', name: 'rows', x: 0, y: BAR_H, w: SCREEN_W, h: Math.min(SCREEN_H - BAR_H, items.length * ROW_H + 2 * LIST_PAD), items, capture: true },
    ],
  };
}

/** The row a press on firmware list item `index` names (outline marks), or null for a fold of older rows. */
export function outlineRowAt(rows: readonly HomeRow[], index: number, clock: (epochMs: number) => string): HomeRow | null {
  return outlineItems(rows, clock)[index]?.row ?? null;
}
