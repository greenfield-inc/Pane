import { describe, expect, it } from 'vitest';
import {
  blendHex, countBufferMatches, createTerminalFindAdapter, parseCssColor,
  type FindBuffer, type FindSearchAddon, type FindTerminal,
} from './terminalFindAdapter';

/** Rows of text; a row starting with "~" continues the previous one (soft wrap). */
function fakeBuffer(rows: string[]): FindBuffer {
  const lines = rows.map(row => row.startsWith('~') ? { text: row.slice(1), wrapped: true } : { text: row, wrapped: false });
  return {
    length: lines.length,
    getLine: (index: number) => {
      const line = lines[index];
      if (!line) return undefined;
      return { isWrapped: line.wrapped, translateToString: () => line.text };
    },
  };
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
