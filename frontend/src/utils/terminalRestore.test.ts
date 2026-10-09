import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminalOutputAcknowledger,
  selectTerminalRestoreContent,
  terminalOutputByteLength,
} from './terminalRestore';

describe('selectTerminalRestoreContent', () => {
  it('prefers the authoritative serialized state for an active alternate screen', () => {
    expect(selectTerminalRestoreContent({
      isAlternateScreen: true,
      scrollbackBuffer: 'claude --resume session-id',
      alternateScreenBuffer: '\x1b[?1049hagent output',
      serializedBuffer: '\x1b[?1049hserialized agent screen',
    })).toEqual({
      content: '\x1b[?1049hserialized agent screen',
      source: 'serialized',
    });
  });

  it('falls back to captured alternate-screen bytes for older state payloads', () => {
    expect(selectTerminalRestoreContent({
      isAlternateScreen: true,
      scrollbackBuffer: 'shell output',
      alternateScreenBuffer: '\x1b[?1049hagent output',
    })).toEqual({
      content: '\x1b[?1049hagent output',
      source: 'alternateScreen',
    });
  });

  it('keeps normal shell restoration on scrollback', () => {
    expect(selectTerminalRestoreContent({
      isAlternateScreen: false,
      scrollbackBuffer: ['first', 'second'],
      serializedBuffer: 'old snapshot',
    })).toEqual({ content: 'first\nsecond', source: 'scrollback' });
  });
});

describe('terminal output acknowledgements', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses UTF-8 bytes for multibyte terminal output', () => {
    expect(terminalOutputByteLength('A界🙂')).toBe(8);
  });

  it('batches consumed chunks until the size threshold', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const acknowledger = createTerminalOutputAcknowledger(send, 5, 100);

    acknowledger.acknowledge('ab');
    expect(send).not.toHaveBeenCalled();
    acknowledger.acknowledge('界');

    expect(send).toHaveBeenCalledWith(5);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flushes a partial batch on the bounded timer and on disposal', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const acknowledger = createTerminalOutputAcknowledger(send, 5_000, 100);

    acknowledger.acknowledge('first');
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenNthCalledWith(1, 5);

    acknowledger.acknowledge('last');
    acknowledger.dispose();
    expect(send).toHaveBeenNthCalledWith(2, 4);
  });
});
