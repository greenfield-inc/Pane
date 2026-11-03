/**
 * Pane's find (Cmd/Ctrl+F) for a terminal tab, on @xterm/addon-search.
 *
 * The addon highlights matches with xterm decorations and re-runs the search
 * itself (200 ms after output is parsed), so counts follow live output and the
 * activation replay. It highlights at most HIGHLIGHT_LIMIT matches, and its
 * resultCount stops there too, so the bar's "n of total" comes from our own
 * scan of the buffer instead.
 */
import type { ISearchDecorationOptions, ISearchOptions } from '@xterm/addon-search';
import type { FindAdapter, FindResult } from '../find/findController';
import { findOffsets } from '../find/findText';

export const HIGHLIGHT_LIMIT = 1000;

interface Rgb { r: number; g: number; b: number }

/** Parse `#rgb`, `#rrggbb(aa)`, `rgb(r g b)` or `rgb(r, g, b[, a])`. */
export function parseCssColor(value: string): Rgb | null {
  const text = value.trim();
  const hex = text.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = digits.slice(0, 3).split('').map(d => parseInt(d + d, 16));
      return { r, g, b };
    }
    if (digits.length === 6 || digits.length === 8) {
      return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16) };
    }
    return null;
  }
  const rgb = text.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return null;
}

const toHex = ({ r, g, b }: Rgb) => `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Mix `color` over `background` (decorations need opaque #RRGGBB). */
export function blendHex(color: Rgb, background: Rgb, amount: number): string {
  return toHex({
    r: color.r * amount + background.r * (1 - amount),
    g: color.g * amount + background.g * (1 - amount),
    b: color.b * amount + background.b * (1 - amount),
  });
}

const FALLBACK_WARNING: Rgb = { r: 210, g: 153, b: 34 };
const FALLBACK_BACKGROUND: Rgb = { r: 17, g: 24, b: 39 };

/** Highlight colours from the current theme's tokens. */
function readFindDecorationColors(): ISearchDecorationOptions {
  const style = getComputedStyle(document.documentElement);
  const warning = parseCssColor(style.getPropertyValue('--color-status-warning')) ?? FALLBACK_WARNING;
  const background = parseCssColor(style.getPropertyValue('--color-terminal-bg')) ?? FALLBACK_BACKGROUND;
  const solid = toHex(warning);
  return {
    matchBackground: blendHex(warning, background, 0.35),
    matchOverviewRuler: solid,
    activeMatchBackground: blendHex(warning, background, 0.75),
    activeMatchBorder: solid,
    activeMatchColorOverviewRuler: solid,
  };
}

interface BufferPosition { row: number; col: number }

/** The parts of xterm's buffer, terminal and SearchAddon this adapter uses. */
export interface FindBuffer {
  length: number;
  getLine(row: number): { isWrapped: boolean; translateToString(): string } | undefined;
}

export interface FindTerminal {
  buffer: { active: FindBuffer };
  hasSelection(): boolean;
  getSelectionPosition(): { start: { x: number; y: number } } | undefined;
  getSelection(): string;
  clearSelection(): void;
  focus(): void;
}

export interface FindSearchAddon {
  findNext(term: string, options?: ISearchOptions): boolean;
  findPrevious(term: string, options?: ISearchOptions): boolean;
  clearDecorations(): void;
  onDidChangeResults(listener: () => void): { dispose(): void };
}

/**
 * Count matches in the buffer (case-insensitive, non-overlapping, soft-wrapped
 * rows joined) and the 1-based index of the one starting at `current`.
 */
export function countBufferMatches(
  buffer: FindBuffer,
  query: string,
  current: BufferPosition | null,
): FindResult {
  if (!query) return { current: 0, total: 0 };
  let total = 0;
  let currentIndex = 0;
  let row = 0;
  while (row < buffer.length) {
    const line = buffer.getLine(row);
    if (!line) { row++; continue; }
    const startRow = row;
    let text = line.translateToString();
    const rowLengths = [text.length];
    while (row + 1 < buffer.length) {
      const next = buffer.getLine(row + 1);
      if (!next?.isWrapped) break;
      row++;
      const nextText = next.translateToString();
      rowLengths.push(nextText.length);
      text += nextText;
    }
    for (const offset of findOffsets(text, query)) {
      total++;
      if (current && currentIndex === 0) {
        let remaining = offset;
        let physicalRow = startRow;
        for (let i = 0; i < rowLengths.length; i++) {
          if (remaining < rowLengths[i] || i === rowLengths.length - 1) { physicalRow = startRow + i; break; }
          remaining -= rowLengths[i];
        }
        if (physicalRow === current.row && remaining === current.col) currentIndex = total;
      }
    }
    row++;
  }
  return { current: currentIndex, total };
}

export interface TerminalFindAdapter extends FindAdapter {
  dispose(): void;
}

export function createTerminalFindAdapter(options: {
  terminal: FindTerminal;
  search: FindSearchAddon;
  report: (result: FindResult) => void;
  readColors?: () => ISearchDecorationOptions;
}): TerminalFindAdapter {
  const { terminal, search, report } = options;
  const readColors = options.readColors ?? readFindDecorationColors;
  let query = '';

  const currentResult = (): FindResult => {
    const selection = terminal.hasSelection() ? terminal.getSelectionPosition() : undefined;
    return countBufferMatches(
      terminal.buffer.active,
      query,
      selection ? { row: selection.start.y, col: selection.start.x } : null,
    );
  };

  // Fires after every search, including the addon's own re-search on new output.
  const subscription = search.onDidChangeResults(() => {
    if (query) report(currentResult());
  });

  const searchOptions = (incremental: boolean): ISearchOptions => ({
    caseSensitive: false,
    incremental,
    decorations: readColors(),
  });

  return {
    mode: () => 'text',
    search(next) {
      query = next;
      search.findNext(next, searchOptions(true));
      return currentResult();
    },
    step(direction) {
      if (!query) return { current: 0, total: 0 };
      if (direction === 'next') search.findNext(query, searchOptions(false));
      else search.findPrevious(query, searchOptions(false));
      return currentResult();
    },
    clear() {
      query = '';
      search.clearDecorations();
      terminal.clearSelection();
    },
    selectedText: () => terminal.getSelection(),
    restoreFocus: () => terminal.focus(),
    dispose: () => subscription.dispose(),
  };
}
