import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';

/**
 * Checks Pane's @xterm/xterm patch: `buffer.getLine(y)` returns undefined past
 * the buffer's end. Unpatched, it returned stale rows left in the circular
 * buffer by earlier output, and the search addon joined a stale soft-wrapped
 * row onto the last line ("0 of N" after wrapping past the last match).
 */
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));

describe('xterm buffer bounds (patched)', () => {
  it('returns no line past the end after clearing a long wrapped line', async () => {
    const terminal = new Terminal({ cols: 100, rows: 20, scrollback: 1000, allowProposedApi: true });
    await write(terminal, `${'a'.repeat(30_000)}\r\nmac% `);
    await write(terminal, `\x1b[H\x1b[2J\x1b[3J${Array.from({ length: 50 }, () => 'b'.repeat(40)).join('\r\n')}\r\nmac% `);
    const buffer = terminal.buffer.active;
    expect(buffer.getLine(buffer.length - 1)?.translateToString(true)).toMatch(/^mac%/);
    expect(buffer.getLine(buffer.length)).toBeUndefined();
    expect(buffer.getLine(buffer.length + 5)).toBeUndefined();
    expect(buffer.getLine(-1)).toBeUndefined();
    terminal.dispose();
  });
});
