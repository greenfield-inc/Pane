import { describe, expect, it } from 'vitest';

import { appendLog, decodeLogEntry, logText, MAX_LOG_LINES } from './logs';

const entry = (message: string) => ({ timestamp: '2026-10-30T09:38:02.000Z', level: 'info' as const, message, source: 'Script' });

describe('decodeLogEntry', () => {
  it('reads a session-log entry, and nothing else', () => {
    expect(decodeLogEntry(entry('ready'))).toEqual(entry('ready'));
    expect(decodeLogEntry({ message: 1 })).toBeNull();
  });
});

describe('appendLog', () => {
  it('keeps the newest lines once the list is full', () => {
    const full = Array.from({ length: MAX_LOG_LINES }, (_, index) => entry(String(index)));
    const next = appendLog(full, entry('new'));
    expect(next).toHaveLength(MAX_LOG_LINES);
    expect(next[0].message).toBe('1');
    expect(next.at(-1)?.message).toBe('new');
  });
});

describe('logText', () => {
  it('drops terminal colour codes and the trailing newline', () => {
    expect(logText(entry('\x1b[32mVITE v6.2.0\x1b[0m  ready in 412 ms\n'))).toBe('VITE v6.2.0  ready in 412 ms');
  });
});
