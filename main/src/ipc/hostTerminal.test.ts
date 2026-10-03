import { describe, expect, it } from 'vitest';
import { decodeHostTerminalOpenRequest } from './hostTerminal';

describe('decodeHostTerminalOpenRequest', () => {
  it('opens without typing when the request is omitted, null (remote /invoke) or empty', () => {
    expect(decodeHostTerminalOpenRequest(undefined)).toEqual({});
    expect(decodeHostTerminalOpenRequest(null)).toEqual({});
    expect(decodeHostTerminalOpenRequest({})).toEqual({});
  });

  it('keeps the text to type', () => {
    expect(decodeHostTerminalOpenRequest({ input: 'gh auth login' })).toEqual({ input: 'gh auth login' });
  });

  it('rejects a malformed request', () => {
    expect(() => decodeHostTerminalOpenRequest({ input: 42 })).toThrow();
    expect(() => decodeHostTerminalOpenRequest('gh auth login')).toThrow();
  });
});
