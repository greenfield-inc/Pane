import { describe, expect, it } from 'vitest';
import {
  blendHex, cellColumnToStringOffset, countBufferMatches, createTerminalFindAdapter, parseCssColor,
  type FindBuffer, type FindBufferLine, type FindCell, type FindSearchAddon, type FindTerminal,
} from './terminalFindAdapter';

const WIDE = /[\u3000-\u9fff\uff00-\uffef]/u;
const COMBINING = /[\u0300-\u036f]/u;

/** Cells the way xterm stores them: a wide char takes two cells (the second is width 0), a combining mark joins the cell before. */
function fakeLine(text: string, isWrapped: boolean): FindBufferLine {
  const cells: Array<{ chars: string; width: number }> = [];
  for (const char of text) {
    const last = cells.at(-1);
    if (COMBINING.test(char) && last) { last.chars += char; continue; }
    if (WIDE.test(char)) { cells.push({ chars: char, width: 2 }, { chars: '', width: 0 }); continue; }
    cells.push({ chars: char, width: 1 });
  }
  const toCell = (cell: { chars: string; width: number }): FindCell => ({
    getWidth: () => cell.width,
    getChars: () => cell.chars,
    getCode: () => cell.chars.codePointAt(0) ?? 0,
  });
  return {
    isWrapped,
    translateToString: () => cells.filter(cell => cell.width > 0).map(cell => cell.chars).join(''),
    getCell: (x: number) => (cells[x] ? toCell(cells[x]) : undefined),
  };
}

/** Rows of text; a row starting with "~" continues the previous one (soft wrap). */
function fakeBuffer(rows: string[]): FindBuffer {
  const lines = rows.map(row => row.startsWith('~') ? fakeLine(row.slice(1), true) : fakeLine(row, false));
  return { length: lines.length, getLine: (index: number) => lines[index] };
}

describe('countBufferMatches', () => {
  it('counts every match and finds the index of the current one', () => {
    const buffer = fakeBuffer(['needle one', 'nothing', 'NEEDLE needle']);
    expect(countBufferMatches(buffer, 'needle', { row: 2, col: 7 })).toEqual({ current: 3, total: 3 });
    expect(countBufferMatches(buffer, 'needle', null)).toEqual({ current: 0, total: 3 });
  });

  it('finds a match split across a soft-wrapped row', () => {
    const buffer = fakeBuffer(['abc nee', '~dle xyz', 'needle']);
    expect(countBufferMatches(buffer, 'needle', { row: 2, col: 0 })).toEqual({ current: 2, total: 2 });
    expect(countBufferMatches(buffer, 'needle', { row: 0, col: 4 })).toEqual({ current: 1, total: 2 });
  });

  it('maps the selection cell column through wide, surrogate-pair and combining characters', () => {
    // "你" takes two cells, so "needle" starts at cell 3 but string offset 2.
    expect(countBufferMatches(fakeBuffer(['你 needle']), 'needle', { row: 0, col: 3 })).toEqual({ current: 1, total: 1 });
    // A surrogate pair in one cell: "needle" starts at cell 2, string offset 3.
    expect(countBufferMatches(fakeBuffer(['😀 needle']), 'needle', { row: 0, col: 2 })).toEqual({ current: 1, total: 1 });
    // "e\u0301" is one cell holding two chars: "needle" starts at cell 2, offset 3.
    expect(countBufferMatches(fakeBuffer(['e\u0301 needle']), 'needle', { row: 0, col: 2 })).toEqual({ current: 1, total: 1 });
    // On a soft-wrapped continuation row.
    expect(countBufferMatches(fakeBuffer(['ab needle', '~你 needle']), 'needle', { row: 1, col: 3 })).toEqual({ current: 2, total: 2 });
  });

  it('cellColumnToStringOffset skips the second cell of a wide char', () => {
    const line = fakeLine('你好 x', false);
    expect(cellColumnToStringOffset(line, 0)).toBe(0);
    expect(cellColumnToStringOffset(line, 2)).toBe(1);
    expect(cellColumnToStringOffset(line, 5)).toBe(3);
  });

  it('counts a late current match in one long soft-wrapped line quickly (C5: 2,500 x 200)', () => {
    const buffer = fakeBuffer(['a'.repeat(200), ...Array.from({ length: 2499 }, () => '~' + 'a'.repeat(200))]);
    const start = performance.now();
    const result = countBufferMatches(buffer, 'a', { row: 2499, col: 199 });
    const elapsed = performance.now() - start;
    expect(result).toEqual({ current: 500_000, total: 500_000 });
    // The old per-hit row walk took 625 million steps here (seconds); one pass takes tens of ms.
    expect(elapsed).toBeLessThan(250);
  });

  it('counts past the highlight limit (one letter over a full 2,500 x 200 scrollback)', () => {
    const buffer = fakeBuffer(Array.from({ length: 2500 }, () => 'a'.repeat(200)));
    const start = performance.now();
    const result = countBufferMatches(buffer, 'a', { row: 0, col: 0 });
    const elapsed = performance.now() - start;
    expect(result).toEqual({ current: 1, total: 500_000 });
    expect(elapsed).toBeLessThan(100);
  });
});

describe('theme colours', () => {
  it('parses the token formats the themes use', () => {
    expect(parseCssColor('rgb(210 153 34)')).toEqual({ r: 210, g: 153, b: 34 });
    expect(parseCssColor('#F2C55C')).toEqual({ r: 242, g: 197, b: 92 });
    expect(parseCssColor('#1f6dc640')).toEqual({ r: 31, g: 109, b: 198 });
    expect(parseCssColor('var(--x)')).toBeNull();
  });

  it('blends to opaque #RRGGBB', () => {
    expect(blendHex({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }, 0.5)).toBe('#808080');
  });
});

describe('createTerminalFindAdapter', () => {
  function setup() {
    const calls: string[] = [];
    const reports: unknown[] = [];
    let listener: (() => void) | null = null;
    let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
    const buffer = fakeBuffer(['needle', 'x needle']);
    const terminal: FindTerminal = {
      buffer: { active: buffer },
      hasSelection: () => !!selection,
      getSelectionPosition: () => selection,
      getSelection: () => 'picked',
      clearSelection: () => { calls.push('clearSelection'); selection = undefined; },
      focus: () => { calls.push('focus'); },
    };
    const search: FindSearchAddon = {
      findNext: (term: string, options?: { incremental?: boolean }) => {
        calls.push(`next:${term}:${options?.incremental ? 'inc' : 'step'}`);
        selection = selection?.start.y === 0 ? { start: { x: 2, y: 1 }, end: { x: 8, y: 1 } } : { start: { x: 0, y: 0 }, end: { x: 6, y: 0 } };
        listener?.();
        return true;
      },
      findPrevious: (term: string) => { calls.push(`prev:${term}`); return true; },
      clearDecorations: () => { calls.push('clearDecorations'); },
      onDidChangeResults: (fn: () => void) => { listener = fn; return { dispose: () => { listener = null; } }; },
    };
    const adapter = createTerminalFindAdapter({
      terminal,
      search,
      report: result => reports.push(result),
      readColors: () => ({ matchOverviewRuler: '#000000', activeMatchColorOverviewRuler: '#000000' }),
    });
    return { adapter, calls, reports, fireLiveUpdate: () => listener?.() };
  }

  it('searches incrementally and reports n of total', () => {
    const { adapter, calls } = setup();
    expect(adapter.search('needle')).toEqual({ current: 1, total: 2 });
    expect(calls).toEqual(['next:needle:inc']);
    expect(adapter.step('next')).toEqual({ current: 2, total: 2 });
  });

  it('counts once per search or step, not again from the addon\'s synchronous callback', () => {
    const { adapter, reports } = setup();
    adapter.search('needle');
    adapter.step('next');
    expect(reports).toEqual([]);
  });

  it('reports again when the addon re-searches after new output', () => {
    const { adapter, reports, fireLiveUpdate } = setup();
    adapter.search('needle');
    reports.length = 0;
    fireLiveUpdate();
    expect(reports).toEqual([{ current: 1, total: 2 }]);
  });

  it('clears highlights and selection, and stops reporting', () => {
    const { adapter, calls, reports, fireLiveUpdate } = setup();
    adapter.search('needle');
    adapter.clear();
    reports.length = 0;
    fireLiveUpdate();
    expect(calls.slice(-2)).toEqual(['clearDecorations', 'clearSelection']);
    expect(reports).toEqual([]);
  });

  it('starts from the selection and returns focus to the terminal', () => {
    const { adapter, calls } = setup();
    expect(adapter.selectedText?.()).toBe('picked');
    adapter.restoreFocus?.();
    expect(calls).toContain('focus');
  });
});
