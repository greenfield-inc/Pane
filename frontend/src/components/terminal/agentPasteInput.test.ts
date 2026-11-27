import { describe, expect, it } from 'vitest';
import { toAgentPasteInput } from './agentPasteInput';

describe('toAgentPasteInput', () => {
  it('turns every kind of newline into Alt+Enter', () => {
    expect(toAgentPasteInput('a\nb\r\nc\rd')).toBe('a\x1b\rb\x1b\rc\x1b\rd');
  });

  it('replaces a leading tab with spaces', () => {
    expect(toAgentPasteInput('Exception: boom\n\tat Foo.bar(Foo.java:215)'))
      .toBe('Exception: boom\x1b\r    at Foo.bar(Foo.java:215)');
  });

  it('pads tabs inside a line to the next tab stop', () => {
    expect(toAgentPasteInput('a\tbc\td\n\t\te')).toBe('a   bc  d\x1b\r        e');
  });
});
