import { describe, expect, it } from 'vitest';
import {
  registerTerminalQueryHandlers,
  TERMINAL_QUERY_SEQUENCES,
  type CsiHandler,
  type CsiIdentifier,
} from './terminalQueries';

/** A stand-in for xterm's parser that keeps the handlers so a test can fire them. */
function fakeParser() {
  const handlers: { id: CsiIdentifier; handler: CsiHandler }[] = [];
  let disposed = 0;

  return {
    handlers,
    get disposedCount() { return disposed; },
    parser: {
      registerCsiHandler(id: CsiIdentifier, handler: CsiHandler) {
        handlers.push({ id, handler });
        return { dispose: () => { disposed += 1; } };
      },
    },
    /** Fire the handler registered for a sequence, newest first as xterm does. */
    fire(id: CsiIdentifier, params: (number | number[])[] = []): boolean {
      const match = [...handlers].reverse().find(entry => sameId(entry.id, id));
      if (!match) throw new Error(`no handler registered for ${JSON.stringify(id)}`);
      return match.handler(params);
    },
  };
}

function sameId(a: CsiIdentifier, b: CsiIdentifier): boolean {
  return a.final === b.final && a.prefix === b.prefix && a.intermediates === b.intermediates;
}

/** DSR cursor-position request — the one Codex reads its viewport origin from. */
const CURSOR_POSITION_REQUEST: CsiIdentifier = { final: 'n' };

describe('registerTerminalQueryHandlers', () => {
  it('answers every query a renderer that owns the voice is asked', () => {
    const parser = fakeParser();
    const answered: number[] = [];
    registerTerminalQueryHandlers(parser.parser, {
      canAnswer: () => true,
      onAnswering: () => answered.push(1),
    });

    for (const sequence of TERMINAL_QUERY_SEQUENCES) {
      // `false` means "not handled here" — xterm's own reply runs, which is the
      // whole point: the renderer is the terminal for this PTY.
      expect(parser.fire(sequence)).toBe(false);
    }
    expect(answered).toHaveLength(TERMINAL_QUERY_SEQUENCES.length);
  });

  it('swallows every query when another renderer owns the voice', () => {
    const parser = fakeParser();
    let answered = 0;
    registerTerminalQueryHandlers(parser.parser, {
      canAnswer: () => false,
      onAnswering: () => { answered += 1; },
    });

    for (const sequence of TERMINAL_QUERY_SEQUENCES) {
      expect(parser.fire(sequence)).toBe(true);
    }
    expect(answered).toBe(0);
  });

  it('re-reads ownership per query, so taking the keyboard needs no rebuild', () => {
    const parser = fakeParser();
    let interactive = false;
    registerTerminalQueryHandlers(parser.parser, {
      canAnswer: () => interactive,
      onAnswering: () => {},
    });

    expect(parser.fire(CURSOR_POSITION_REQUEST, [6])).toBe(true);
    interactive = true;
    expect(parser.fire(CURSOR_POSITION_REQUEST, [6])).toBe(false);
  });

  it('refuses focus reporting even to the renderer that owns the voice', () => {
    const parser = fakeParser();
    registerTerminalQueryHandlers(parser.parser, {
      canAnswer: () => true,
      onAnswering: () => {},
    });

    // A tile gaining focus is not the agent's terminal gaining focus, so the
    // mode is never enabled and no focus event is ever written to the PTY.
    expect(parser.fire({ prefix: '?', final: 'h' }, [1004])).toBe(true);
    expect(parser.fire({ prefix: '?', final: 'l' }, [1004])).toBe(true);
    // Unrelated private modes still belong to xterm.
    expect(parser.fire({ prefix: '?', final: 'h' }, [1049])).toBe(false);
  });

  it('covers the sequences that produce a reply on the input stream', () => {
    // Named rather than counted, so dropping one is a failing test and not a
    // silently unanswered agent.
    expect(TERMINAL_QUERY_SEQUENCES).toEqual([
      { final: 'n' },
      { prefix: '?', final: 'n' },
      { final: 'c' },
      { prefix: '>', final: 'c' },
      { prefix: '=', final: 'c' },
      { prefix: '>', final: 'q' },
      { final: 't' },
      { prefix: '?', intermediates: '$', final: 'p' },
    ]);
  });

  it('hands back every registration so a torn-down tile leaves nothing behind', () => {
    const parser = fakeParser();
    const disposables = registerTerminalQueryHandlers(parser.parser, {
      canAnswer: () => true,
      onAnswering: () => {},
    });

    expect(disposables).toHaveLength(parser.handlers.length);
    for (const disposable of disposables) disposable.dispose();
    expect(parser.disposedCount).toBe(parser.handlers.length);
  });
});
