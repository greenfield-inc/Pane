import { describe, it, expect } from 'vitest';
import { injectionSequence } from './terminalInjection';

/**
 * Guards the fix for a resume that ran as `laude --resume …`: the shell had
 * swallowed the first byte written after its prompt, and the command failed as
 * "command not found" with no hint that a character was missing.
 */
describe('injectionSequence', () => {
  it('sends a sacrificial byte before the command', () => {
    const [primer, line] = injectionSequence('claude --resume abc123');

    expect(primer).toBe('\x15');
    expect(line).toBe('claude --resume abc123\r');
  });

  it('keeps the command intact — the primer is separate, never a prefix', () => {
    const [primer, line] = injectionSequence('codex resume --yolo');

    expect(line.startsWith('codex')).toBe(true);
    expect(line).not.toContain(primer);
  });

  it('submits with a carriage return, as a terminal expects', () => {
    expect(injectionSequence('ls')[1].endsWith('\r')).toBe(true);
  });

  /** Ctrl-U clears the input line: harmless at an empty prompt, in every shell. */
  it('uses a primer that does nothing at a fresh prompt', () => {
    expect(injectionSequence('x')[0]).toBe('\x15');
  });
});
