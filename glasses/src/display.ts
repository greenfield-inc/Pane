// Adapted from GlanceCode (https://github.com/sousyllc/glancecode), MIT License, Copyright (c) 2026 Sousy LLC. See LICENSE.
// Owns the glasses page. A screen is a list of boxes; this turns them into SDK containers and
// sends the cheapest update: in-place text upgrades when the layout is unchanged, a rebuild otherwise.
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import type { GlassesBridge } from './bridge';
import { clampBytes, fitLine } from './text';

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

export type Box = TextBox | ListBox;

export interface Page {
  boxes: Box[];
}

const MAX_BOXES = 8;
const MAX_LIST_ITEMS = 20;
/** The simulator caps a list item at 63 UTF-8 bytes (Even's docs say 64 characters). */
const MAX_LIST_ITEM_BYTES = 63;
/** The simulator caps a text container at 999 UTF-8 bytes (Even's docs say 1,000 characters on create). */
const MAX_TEXT_BYTES = 999;
export const LIST_PAD = 4;
const TEXT_PAD = 4;
const LIST_ITEM_INSET = 16;

export function textContent(box: TextBox): string {
  return clampBytes(box.lines.join('\n'), MAX_TEXT_BYTES) || ' ';
}

export function listItems(box: ListBox): string[] {
  const maxPx = box.w - 2 * LIST_PAD - LIST_ITEM_INSET;
  return box.items.slice(0, MAX_LIST_ITEMS).map((item) => clampBytes(fitLine(item, maxPx), MAX_LIST_ITEM_BYTES) || ' ');
}

/** What `rebuildPageContainer` needs; changes to anything else go through `textContainerUpgrade`. */
function layoutKey(page: Page): string {
  return JSON.stringify(page.boxes.map((box) => (box.kind === 'list'
    ? [box.kind, box.name, box.x, box.y, box.w, box.h, Boolean(box.capture), Boolean(box.border), listItems(box)]
    : [box.kind, box.name, box.x, box.y, box.w, box.h, Boolean(box.capture), Boolean(box.border), box.pad ?? TEXT_PAD])));
}

/** Throws when a page breaks a G2 rule; screens are built to pass, so this guards against regressions. */
export function checkPage(page: Page): void {
  if (page.boxes.length === 0 || page.boxes.length > MAX_BOXES) throw new Error(`A page needs 1 to ${MAX_BOXES} boxes; got ${page.boxes.length}.`);
  if (page.boxes.filter((box) => box.capture).length !== 1) throw new Error('A page needs exactly one box that captures input.');
  const names = new Set(page.boxes.map((box) => box.name));
  if (names.size !== page.boxes.length || [...names].some((name) => name.length > 16)) throw new Error('Box names must be unique and at most 16 characters.');
}

function containers(page: Page) {
  const textObject: TextContainerProperty[] = [];
  const listObject: ListContainerProperty[] = [];
  page.boxes.forEach((box, index) => {
    const frame = {
      containerID: index + 1,
      containerName: box.name,
      xPosition: box.x,
      yPosition: box.y,
      width: box.w,
      height: box.h,
      borderWidth: box.border ? 2 : 0,
      borderColor: box.border ? 13 : 0,
      borderRadius: box.border ? 6 : 0,
      isEventCapture: box.capture ? 1 : 0,
    };
    if (box.kind === 'list') {
      const items = listItems(box);
      listObject.push(new ListContainerProperty({
        ...frame,
        paddingLength: LIST_PAD,
        itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: box.w - 2 * LIST_PAD, isItemSelectBorderEn: 1, itemName: items }),
      }));
    } else {
      textObject.push(new TextContainerProperty({
        ...frame,
        paddingLength: box.pad ?? TEXT_PAD,
        content: textContent(box),
        textColor: box.brightness ?? BRIGHT,
      }));
    }
  });
  return { containerTotalNum: page.boxes.length, textObject, listObject };
}

interface Shown {
  layout: string;
  texts: Map<string, { content: string; brightness: Brightness }>;
}

function shownOf(page: Page): Shown {
  const texts = new Map<string, { content: string; brightness: Brightness }>();
  for (const box of page.boxes) {
    if (box.kind === 'text') texts.set(box.name, { content: textContent(box), brightness: box.brightness ?? BRIGHT });
  }
  return { layout: layoutKey(page), texts };
}

/** Serializes every write to the glasses; a page shown while a write is in flight replaces any older pending one. */
export class Display {
  private created = false;
  private shown: Shown | null = null;
  private pending: Page | null = null;
  private busy: Promise<void> | null = null;
  /** When the last write finished; the input router ignores phantom scrolls right after it. */
  lastWriteAt = 0;
  onPage: (page: Page) => void = () => {};

  constructor(private readonly bridge: GlassesBridge) {}

  /** Forget what is on the glasses, so the next page is sent in full. */
  invalidate(): void {
    this.shown = null;
  }

  show(page: Page): Promise<void> {
    checkPage(page);
    this.pending = page;
    this.onPage(page);
    this.busy ??= this.flush().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async flush(): Promise<void> {
    while (this.pending) {
      const page = this.pending;
      this.pending = null;
      try {
        await this.write(page);
      } catch (error) {
        // The glasses may have dropped the write; send the whole next page.
        this.shown = null;
        console.error('[Pane glasses] display write failed', error);
      }
      this.lastWriteAt = Date.now();
    }
  }

  private async write(page: Page): Promise<void> {
    const next = shownOf(page);
    if (!this.created) {
      const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containers(page)));
      this.created = true;
      // A second startup call is refused; a failed one leaves later pages to rebuild.
      if (Number(result) !== 0) await this.bridge.rebuildPageContainer(new RebuildPageContainer(containers(page)));
      this.shown = next;
      return;
    }
    const shown = this.shown;
    const changed = [...next.texts].filter(([name, want]) => {
      const have = shown?.texts.get(name);
      return !have || have.content !== want.content || have.brightness !== want.brightness;
    }).length;
    // A whole new screen goes in one rebuild: box-by-box upgrades would show the old body under
    // the new header for a moment.
    const wholeScreen = next.texts.size > 1 && changed === next.texts.size;
    if (!shown || shown.layout !== next.layout || wholeScreen) {
      await this.bridge.rebuildPageContainer(new RebuildPageContainer(containers(page)));
      this.shown = next;
      return;
    }
    for (const [index, box] of page.boxes.entries()) {
      if (box.kind !== 'text') continue;
      const want = next.texts.get(box.name);
      const have = shown.texts.get(box.name);
      if (!want || (have && have.content === want.content && have.brightness === want.brightness)) continue;
      await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: index + 1,
        containerName: box.name,
        content: want.content,
        textColor: want.brightness,
      }));
      shown.texts.set(box.name, want);
    }
  }
}
