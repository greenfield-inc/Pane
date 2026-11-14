// Turns a Pane glasses page into Glassly scene elements. Even's firmware draws lists and moves
// their highlight itself; Glassly has no list element, so this draws a list as one text element
// with a "> " on the highlighted row and keeps the highlight here (see ListFocus).
import type { RenderElement } from '@glassly/miniapp';
import { LIST_PAD, TEXT_PAD, listItems, textContent, type Box, type Brightness, type ListBox, type Page, type TextBox } from '../../../src/page';

/** What one Glassly display takes per frame. */
export interface Budget {
  /** Text and rect elements share this pool on stock G2. */
  maxText: number;
}

/** Even's list rows are 40 px apart, so a list shows this many rows in its box. */
const LIST_ROW_H = 40;

/** Even's five brightness steps as Glassly's 16 gray levels. */
const GRAY: Record<Brightness, number> = { 0: 0, 1: 5, 2: 9, 3: 12, 4: 15 };

/**
 * Text keeps Pane's own wrapping (the Even firmware font at 27 px a line, which `text.ts`
 * measures): Glassly passes `builtin` text through without re-wrapping it to its 40 px rows.
 * (assumed: stock G2 under Glassly draws it with the same firmware font; P0 checks.)
 */
const FONT = 'builtin';

/** The highlighted row of each list on the page, by box name. */
export type ListSelection = ReadonlyMap<string, number>;

/** The rows a list box shows: a window around the highlight, the highlighted row marked. */
export function listLines(box: ListBox, selected: number): string[] {
  const items = listItems(box);
  const rows = Math.max(1, Math.floor((box.h - 2 * LIST_PAD) / LIST_ROW_H));
  const at = Math.max(0, Math.min(selected, items.length - 1));
  const first = Math.max(0, Math.min(at - rows + 1, items.length - rows));
  return items.slice(first, first + rows).map((item, index) => `${first + index === at ? '> ' : '   '}${item}`);
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
    for (let start = 0; start < sorted.length; start += 1) {
      const run = [sorted[start] as Stacked];
      while (start + run.length < sorted.length && touching(run[run.length - 1] as Stacked, sorted[start + run.length] as Stacked)) run.push(sorted[start + run.length] as Stacked);
      if (run.length > best.length) best = run;
    }
    if (best.length < 2) return out.slice(0, maxText);
    const first = best[0] as Stacked;
    const last = best[best.length - 1] as Stacked;
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
  for (const box of page.boxes) {
    if (box.kind === 'text') texts.push({ box, lines: textContent(box).split('\n') });
    else if (box.kind === 'list') lists.push(textElement(box, listLines(box, selection.get(box.name) ?? 0).join('\n'), 4));
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

/**
 * Keeps the highlight of each list the way Even's firmware does: a new list starts on its first
 * row, the same list keeps its row across redraws, swipes move it and stop at the ends.
 */
export class ListFocus {
  private key = '';
  private selected = new Map<string, number>();

  /** Call with each page shown; returns the selection to draw it with. */
  show(page: Page): ListSelection {
    const lists = page.boxes.filter((box): box is ListBox => box.kind === 'list');
    const key = JSON.stringify(lists.map((box) => [box.name, box.items]));
    if (key !== this.key) {
      this.key = key;
      this.selected = new Map(lists.map((box) => [box.name, 0]));
    }
    return this.selected;
  }

  /** Moves the highlight of `list`; false when it was already at that end. */
  move(list: ListBox, step: 1 | -1): boolean {
    const at = this.selected.get(list.name) ?? 0;
    const next = Math.max(0, Math.min(at + step, Math.min(list.items.length, listItems(list).length) - 1));
    if (next === at) return false;
    this.selected.set(list.name, next);
    return true;
  }

  selectedIn(list: ListBox): number {
    return this.selected.get(list.name) ?? 0;
  }
}
