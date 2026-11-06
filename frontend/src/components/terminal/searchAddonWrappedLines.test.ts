import { describe, expect, it } from 'vitest';
import { SearchAddon } from '@xterm/addon-search';
import type { IBuffer, IBufferCell, IBufferLine, Terminal } from '@xterm/xterm';

/**
 * Runs the real (patched) @xterm/addon-search against a small fake terminal,
 * to check the patch in patches/@xterm__addon-search@*.patch: long
 * soft-wrapped lines are searched in linear time and every match is found.
 */
interface Selection { start: { x: number; y: number }; end: { x: number; y: number } }

/** The members of xterm's Terminal that the search addon uses. */
type SearchHost = Pick<Terminal, 'cols' | 'rows' | 'options' | 'getSelectionPosition' | 'clearSelection' | 'select'
  | 'scrollLines' | 'scrollToLine' | 'onLineFeed' | 'onCursorMove' | 'onResize' | 'onWriteParsed' | 'registerDecoration'>
  & { buffer: { active: Pick<IBuffer, 'length' | 'baseY' | 'viewportY' | 'getLine'> } };

function fakeTerminal(rows: string[], cols: number) {
  const lines = rows.map((text, index) => ({
    isWrapped: index > 0 && text.startsWith('~'),
    text: text.startsWith('~') ? text.slice(1) : text,
  }));
  let selection: Selection | undefined;
  const reads = { cells: 0 };
  const noop = () => ({ dispose() {} });
  const bufferLine = (line: { isWrapped: boolean; text: string }): IBufferLine => ({
    isWrapped: line.isWrapped,
    length: cols,
    translateToString: (trimRight?: boolean) => (trimRight ? line.text.trimEnd() : line.text.padEnd(cols, ' ')),
    getCell: (x: number) => {
      reads.cells += 1;
      if (x >= cols) return undefined;
      const char = line.text[x] ?? '';
      const cell = { getChars: () => char, getWidth: () => 1, getCode: () => char.codePointAt(0) ?? 0 };
      // SAFETY: the addon reads only these three members of a cell.
      return cell as IBufferCell;
    },
  });
  const terminal: SearchHost = {
    cols,
    rows: Math.min(lines.length, 40),
    buffer: { active: { length: lines.length, baseY: Math.max(0, lines.length - 40), viewportY: 0, getLine: (y: number) => (lines[y] ? bufferLine(lines[y]) : undefined) } },
    options: {},
    getSelectionPosition: () => selection,
    clearSelection: () => { selection = undefined; },
    select: (x: number, y: number, size: number) => {
      const end = x + size;
      selection = { start: { x, y }, end: { x: end % cols, y: y + Math.floor(end / cols) } };
    },
    scrollLines: () => {},
    scrollToLine: () => {},
    onLineFeed: noop, onCursorMove: noop, onResize: noop, onWriteParsed: noop,
    registerDecoration: () => undefined,
  };
  return { terminal, reads, selection: () => selection };
}

/** One logical line of `length` chars wrapped at `cols`, with "needle" at each of `at`. */
function wrappedLine(length: number, cols: number, at: number[]): string[] {
  const chars = Array.from({ length }, () => 'x');
  for (const offset of at) 'needle'.split('').forEach((c, i) => { chars[offset + i] = c; });
  const text = chars.join('');
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += cols) rows.push((i === 0 ? '' : '~') + text.slice(i, i + cols));
  return rows;
}

describe('@xterm/addon-search on soft-wrapped lines (patched)', () => {
  const cols = 200;
  // Sparse matches across a 2,500-row wrapped line, one straddling a row edge.
  const at = [5, 197, 60_123, 250_000, 499_990];
  const setup = () => {
    const { terminal, reads, selection } = fakeTerminal(['first line', ...wrappedLine(500_000, cols, at), 'last line'], cols);
    const addon = new SearchAddon();
    // SAFETY: SearchHost lists every Terminal member the addon reads.
    addon.activate(terminal as Terminal);
    return { addon, reads, selection };
  };
  const toPosition = (offset: number) => ({ x: offset % cols, y: 1 + Math.floor(offset / cols) });

  it('visits every match in order going forward, and wraps', () => {
    const { addon, selection } = setup();
    const seen = [];
    for (let i = 0; i < at.length + 1; i++) {
      expect(addon.findNext('needle')).toBe(true);
      seen.push(selection()?.start);
    }
    expect(seen).toEqual([...at.map(toPosition), toPosition(at[0])]);
  });

  it('visits every match in reverse going back', () => {
    const { addon, selection } = setup();
    const seen = [];
    for (let i = 0; i < at.length; i++) {
      expect(addon.findPrevious('needle')).toBe(true);
      seen.push(selection()?.start);
    }
    expect(seen).toEqual([...at].reverse().map(toPosition));
  });

  it('answers a query with no match in one pass over the line', () => {
    const { addon, reads } = setup();
    const start = performance.now();
    expect(addon.findNext('kiwi', { incremental: true })).toBe(false);
    const elapsed = performance.now() - start;
    // Unpatched, every wrapped row re-walked the cells of every row before it (~600M reads).
    expect(reads.cells).toBeLessThan(5_000_000);
    expect(elapsed).toBeLessThan(500);
  });
});
