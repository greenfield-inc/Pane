// Turns a Pane glasses page into Glassly scene elements. Even's firmware draws lists and moves
// their highlight itself; Glassly has no list element, so this draws a list as one text element
// with a "> " on the highlighted row and keeps the highlight here (see ListFocus).
import type { RenderElement } from '@glassly/miniapp';
import { LIST_PAD, TEXT_PAD, listItems, textContent, type Box, type Brightness, type ListBox, type Page, type TextBox } from '../../../src/page';
import { LINE_H, fitLine, textWidth } from '../../../src/text';

/** What one Glassly display takes per frame. */
export interface Budget {
  /** Text and rect elements share this pool on stock G2. */
  maxText: number;
}

/** Even's five brightness steps as Glassly's 16 gray levels. */
const GRAY = { 0: 0, 1: 5, 2: 9, 3: 12, 4: 15 } satisfies Record<Brightness, number>;

/**
 * Text keeps Pane's own wrapping (the Even firmware font at 27 px a line, which `text.ts`
 * measures): Glassly passes `builtin` text through without re-wrapping it to its 40 px rows.
 * (assumed: stock G2 under Glassly draws it with the same firmware font; P0 checks.)
 */
const FONT = 'builtin';

/** The highlighted row of each list, and how far each text box is scrolled, by box name. */
export interface ListSelection {
  rows: ReadonlyMap<string, number>;
  scrolled: ReadonlyMap<string, number>;
}

/** Lines of Pane's text that fit a text box (Even's firmware font, 27 px a line). */
function linesThatFit(box: TextBox): number {
  return Math.max(1, Math.floor((box.h - 2 * (box.pad ?? TEXT_PAD)) / LINE_H));
}

/** The rows a list box shows: a window around the highlight, the highlighted row marked. */
function listLines(box: ListBox, selected: number): string[] {
  const items = listItems(box);
  // Drawn as text, rows sit a text line apart, so more of them fit than in Even's 40 px list rows.
  const rows = Math.max(1, Math.floor((box.h - 2 * LIST_PAD) / LINE_H));
  const at = Math.max(0, Math.min(selected, items.length - 1));
  const first = Math.max(0, Math.min(at - rows + 1, items.length - rows));
  // Each row gives up the room its "> " mark takes, so the text is cut with "…", not by the glasses.
  const room = box.w - 2 * LIST_PAD - textWidth('> ') - 8;
  return items.slice(first, first + rows).map((item, index) => `${first + index === at ? '> ' : '   '}${fitLine(item, room)}`);
}

function textElement(box: TextBox | ListBox, text: string, brightness: Brightness): RenderElement {
  const style: NonNullable<Extract<RenderElement, { type: 'text' }>['style']> = { font: FONT, color: GRAY[brightness] };
  if (box.border) {
    style.border = 2;
    style.radius = 6;
  }
  return { type: 'text', id: box.name, box: { x: box.x, y: box.y, w: box.w, h: box.h }, text, style };
}

interface Stacked {
  box: TextBox;
  lines: string[];
}

/**
 * Merges text boxes stacked directly on top of each other (same column, touching) until the page
 * fits the budget, a whole stack at a time so its rows stay evenly spaced: home's six rows become
 * one element. A page that still doesn't fit loses its last boxes, as Glassly would drop them.
 */
function fitBudget(boxes: Stacked[], maxText: number): Stacked[] {
  let out = [...boxes];
  while (out.length > maxText) {
    const sorted = [...out].sort((a, b) => a.box.y - b.box.y);
    const touching = (upper: Stacked, lower: Stacked) => lower.box.x === upper.box.x && lower.box.w === upper.box.w && lower.box.y === upper.box.y + upper.box.h;
    let best: Stacked[] = [];
    let run: Stacked[] = [];
    for (const stacked of sorted) {
      const previous = run.at(-1);
      run = previous && touching(previous, stacked) ? [...run, stacked] : [stacked];
      if (run.length > best.length) best = run;
    }
    const first = best[0];
    const last = best.at(-1);
    if (best.length < 2 || !first || !last) return out.slice(0, maxText);
    const merged: Stacked = {
      box: { ...first.box, h: last.box.y + last.box.h - first.box.y, brightness: 4 },
      lines: best.flatMap((stacked) => stacked.lines),
    };
    out = [...out.filter((stacked) => !best.includes(stacked)), merged];
  }
  return out;
}

/**
 * The scene for `page`. Images are left out: OS logos need an image encoder the background
 * runtime doesn't have, and rows carry text status marks instead.
 */
export function renderPage(page: Page, selection: ListSelection, budget: Budget): RenderElement[] {
  const texts: Stacked[] = [];
  const lists: RenderElement[] = [];
  const images = page.boxes.filter((box) => box.kind === 'image');
  for (const original of page.boxes) {
    // Images aren't drawn here, so a text box beside one (home's rows next to their logos) takes its room.
    const beside = original.kind === 'text' ? images.find((image) => image.x + image.w <= original.x && original.x - (image.x + image.w) <= 8 && image.y < original.y + original.h && original.y < image.y + image.h) : undefined;
    const box = original.kind === 'text' && beside ? { ...original, x: beside.x, w: original.w + original.x - beside.x } : original;
    if (box.kind === 'text') {
      // Even's firmware scrolls a text box longer than the screen; here the swipes move this window.
      const lines = textContent(box).split('\n');
      const from = selection.scrolled.get(box.name) ?? 0;
      texts.push({ box, lines: box.capture && lines.length > linesThatFit(box) ? lines.slice(from, from + linesThatFit(box)) : lines });
    } else if (box.kind === 'list') lists.push(textElement(box, listLines(box, selection.rows.get(box.name) ?? 0).join('\n'), 4));
  }
  const fitted = fitBudget(texts, Math.max(0, budget.maxText - lists.length));
  const pad = (box: Box) => (box.kind === 'text' ? box.pad ?? TEXT_PAD : TEXT_PAD);
  return [
    ...fitted.map(({ box, lines }) => {
      const element = textElement(box, lines.join('\n') || ' ', box.brightness ?? 4);
      // Even pads text inside its container; Glassly has no padding, so the box moves in instead.
      const inset = pad(box);
      if (element.type === 'text' && inset && !box.border) element.box = { x: box.x + inset, y: box.y + inset, w: Math.max(1, box.w - 2 * inset), h: Math.max(1, box.h - 2 * inset) };
      return element;
    }),
    ...lists,
  ];
}

/** The page's list that takes swipes and presses, if any. */
export function capturedList(page: Page): ListBox | null {
  return page.boxes.find((box): box is ListBox => box.kind === 'list' && box.capture === true) ?? null;
}

/** The page's text box that takes swipes and is longer than it shows, if any. */
export function scrollableText(page: Page): TextBox | null {
  const box = page.boxes.find((candidate): candidate is TextBox => candidate.kind === 'text' && candidate.capture === true);
  return box && textContent(box).split('\n').length > linesThatFit(box) ? box : null;
}

/**
 * Keeps what Even's firmware keeps for a page: each list's highlight (a new list starts on its
 * `selected` row or the first, the same list keeps its row across redraws, swipes stop at the
 * ends) and how far a long text box is scrolled.
 */
export class ListFocus {
  private key = '';
  private rows = new Map<string, number>();
  private scrolled = new Map<string, number>();

  /** Call with each page shown; returns the selection to draw it with. */
  show(page: Page): ListSelection {
    const lists = page.boxes.filter((box): box is ListBox => box.kind === 'list');
    const scrollable = scrollableText(page);
    const key = JSON.stringify([lists.map((box) => [box.name, box.items]), scrollable ? [scrollable.name, scrollable.lines] : null]);
    if (key !== this.key) {
      this.key = key;
      this.rows = new Map(lists.map((box) => [box.name, Math.max(0, Math.min(box.selected ?? 0, box.items.length - 1))]));
      this.scrolled = new Map();
    }
    return { rows: this.rows, scrolled: this.scrolled };
  }

  /** Moves the highlight of `list`; false when it was already at that end. */
  move(list: ListBox, step: 1 | -1): boolean {
    const at = this.rows.get(list.name) ?? 0;
    const next = Math.max(0, Math.min(at + step, Math.min(list.items.length, listItems(list).length) - 1));
    if (next === at) return false;
    this.rows.set(list.name, next);
    return true;
  }

  /** Scrolls a long text box by most of a screen, keeping one line in view; false at either end. */
  scroll(box: TextBox, step: 1 | -1): boolean {
    const fit = linesThatFit(box);
    const last = Math.max(0, textContent(box).split('\n').length - fit);
    const at = this.scrolled.get(box.name) ?? 0;
    const next = Math.max(0, Math.min(at + step * Math.max(1, fit - 1), last));
    if (next === at) return false;
    this.scrolled.set(box.name, next);
    return true;
  }

  selectedIn(list: ListBox): number {
    return this.rows.get(list.name) ?? 0;
  }
}
