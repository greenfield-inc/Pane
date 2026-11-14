// A glasses screen as data: positioned text, list and image boxes. Screens build pages; each host
// (the Even app's Display, Glassly's renderer) turns them into what its glasses draw.
import type { MachineOs } from './model';
import { clampBytes, fitLine } from './text';

/** One row's mark on a logo strip: its OS (null for the monitor), dimmed while its computer is away; `blank` draws none. */
export interface StripMark {
  os: MachineOs | null;
  dim: boolean;
  blank?: boolean;
}

/** Text brightness, 0 (off) to 4 (full). */
export type Brightness = 0 | 1 | 2 | 3 | 4;

export const BRIGHT: Brightness = 4;
export const DIM: Brightness = 2;
export const DIMMER: Brightness = 1;

interface BoxFrame {
  /** Container name: at most 16 characters, unique on the page. */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The one box on a page that receives gestures. */
  capture?: boolean;
  border?: boolean;
}

export interface TextBox extends BoxFrame {
  kind: 'text';
  lines: string[];
  brightness?: Brightness;
  pad?: number;
}

export interface ListBox extends BoxFrame {
  kind: 'list';
  items: string[];
}

/** A grayscale picture. `key` names what it shows; it is drawn and sent only when the key changes. */
export interface ImageBox extends BoxFrame {
  kind: 'image';
  key: string;
  /** What the picture shows: one mark per row from the top, each `rowHeight` px high. */
  marks: StripMark[];
  rowHeight: number;
}

export type Box = TextBox | ListBox | ImageBox;

export interface Page {
  boxes: Box[];
}

const MAX_BOXES = 12;
const MAX_TEXT_BOXES = 8;
const MAX_IMAGE_BOXES = 4;
/** The firmware shows at most this many rows in one list. */
export const MAX_LIST_ITEMS = 20;
/** The simulator caps a list item at 63 UTF-8 bytes (Even's docs say 64 characters). */
const MAX_LIST_ITEM_BYTES = 63;
/** The simulator caps a text container at 999 UTF-8 bytes (Even's docs say 1,000 characters on create). */
const MAX_TEXT_BYTES = 999;
export const LIST_PAD = 4;
export const TEXT_PAD = 4;
const LIST_ITEM_INSET = 16;

export function textContent(box: TextBox): string {
  return clampBytes(box.lines.join('\n'), MAX_TEXT_BYTES) || ' ';
}

export function listItems(box: ListBox): string[] {
  const maxPx = box.w - 2 * LIST_PAD - LIST_ITEM_INSET;
  return box.items.slice(0, MAX_LIST_ITEMS).map((item) => clampBytes(fitLine(item, maxPx), MAX_LIST_ITEM_BYTES) || ' ');
}

/** Throws when a page breaks a G2 rule; screens are built to pass, so this guards against regressions. */
export function checkPage(page: Page): void {
  if (page.boxes.length === 0 || page.boxes.length > MAX_BOXES) throw new Error(`A page needs 1 to ${MAX_BOXES} boxes; got ${page.boxes.length}.`);
  if (page.boxes.filter((box) => box.kind === 'text').length > MAX_TEXT_BOXES) throw new Error(`A page holds at most ${MAX_TEXT_BOXES} text boxes.`);
  if (page.boxes.filter((box) => box.kind === 'image').length > MAX_IMAGE_BOXES) throw new Error(`A page holds at most ${MAX_IMAGE_BOXES} images.`);
  if (page.boxes.filter((box) => box.capture && box.kind !== 'image').length !== 1) throw new Error('A page needs exactly one box that captures input.');
  const names = new Set(page.boxes.map((box) => box.name));
  if (names.size !== page.boxes.length || [...names].some((name) => name.length > 16)) throw new Error('Box names must be unique and at most 16 characters.');
}

