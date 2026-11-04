import { describe, expect, it, vi } from 'vitest';
import { hydrateRemoteTerminalSnapshot } from './terminalSnapshot';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('remote snapshot ownership', () => {
  it('does not write an aborted old snapshot after a newer restore completes', async () => {
    let screen = '';
    let generation = 1;
    const old = deferred<string>();
    const controller = new AbortController();
    const terminal = {
      buffer: { active: { baseY: 12, viewportY: 7 } },
      reset: vi.fn(() => { screen = ''; }),
      write: vi.fn((text: string, done: () => void) => { screen += text; done(); }),
      scrollToLine: vi.fn(),
    };
    const first = hydrateRemoteTerminalSnapshot(terminal, () => old.promise, () => generation === 1 && !controller.signal.aborted);
    controller.abort();
    generation = 2;
    expect(await hydrateRemoteTerminalSnapshot(terminal, async () => 'NEW', () => generation === 2)).toBe(true);
    old.resolve('OLD');
    expect(await first).toBe(false);
    expect(screen).toBe('NEW');
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(7);
  });

  it('cannot scroll or report completion after losing ownership during xterm rendering', async () => {
    let owns = true;
    let rendered = () => {};
    const terminal = {
      buffer: { active: { baseY: 12, viewportY: 7 } }, reset: vi.fn(),
      write: vi.fn((_text: string, done: () => void) => { rendered = done; }), scrollToLine: vi.fn(),
    };
    const result = hydrateRemoteTerminalSnapshot(terminal, async () => 'snapshot', () => owns);
    await Promise.resolve();
    owns = false;
    rendered();
    expect(await result).toBe(false);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });
});
