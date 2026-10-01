import { describe, expect, it } from 'vitest';
import {
  allocateOpenCodeSessionId,
  isValidOpenCodeSessionId,
  OPENCODE_SESSION_ID_PATTERN,
  resolveOpenCodeLaunchCommand,
} from './opencodeLaunch';

describe('OpenCode session ids', () => {
  it('allocates an OpenCode session id from a UUID', () => {
    expect(allocateOpenCodeSessionId(() => '123e4567-e89b-12d3-a456-426614174000'))
      .toBe('ses_123e4567e89b12d3a456426614174000');
  });

  it.each([
    'ses_a',
    'ses_ABC123',
    'ses_123e4567e89b12d3a456426614174000',
  ])('accepts the valid id %s', (sessionId) => {
    expect(isValidOpenCodeSessionId(sessionId)).toBe(true);
  });

  it.each([
    'ses_',
    'ses_has-hyphens',
    'ses_has.dot',
    'ses_has space',
    'session_abc123',
    'ses_trailing-newline\n',
    'ses_trailing-carriage-return\r',
    'ses_trailing-line-separator\u2028',
    'ses_trailing-paragraph-separator\u2029',
  ])('rejects the invalid id %s', (sessionId) => {
    expect(isValidOpenCodeSessionId(sessionId)).toBe(false);
    expect(OPENCODE_SESSION_ID_PATTERN.test(sessionId)).toBe(false);
  });

  it('trims persisted input before validating and inserting it', () => {
    expect(resolveOpenCodeLaunchCommand({
      baseCommand: 'opencode --auto',
      persistedSessionId: '  ses_persisted123\n',
    })).toEqual({
      commandToRun: 'opencode --auto --session "ses_persisted123"',
      sessionId: 'ses_persisted123',
    });
  });
});

describe('resolveOpenCodeLaunchCommand', () => {
  it('allocates and appends a session selector', () => {
    expect(resolveOpenCodeLaunchCommand({
      baseCommand: 'opencode --auto',
      allocateSessionId: () => 'ses_generated',
    })).toEqual({
      commandToRun: 'opencode --auto --session "ses_generated"',
      sessionId: 'ses_generated',
    });
  });

  it.each([
    'opencode --auto --session ses_long',
    'opencode --auto --session=ses_equals',
    'opencode --auto -s ses_short',
  ])('retains one valid selector without rewriting the command: %s', (baseCommand) => {
    expect(resolveOpenCodeLaunchCommand({ baseCommand })).toEqual({
      commandToRun: baseCommand,
      sessionId: baseCommand.includes('equals')
        ? 'ses_equals'
        : baseCommand.includes('short') ? 'ses_short' : 'ses_long',
    });
  });

  it('inserts a valid persisted id', () => {
    expect(resolveOpenCodeLaunchCommand({
      baseCommand: 'opencode --auto',
      persistedSessionId: 'ses_saved',
    })).toEqual({
      commandToRun: 'opencode --auto --session "ses_saved"',
      sessionId: 'ses_saved',
    });
  });

  it('preserves quoted unrelated arguments byte-for-byte', () => {
    const baseCommand = 'opencode --model "large model" \'describe --session ses_not_a_selector\'';
    expect(resolveOpenCodeLaunchCommand({
      baseCommand,
      allocateSessionId: () => 'ses_generated',
    })).toEqual({
      commandToRun: `${baseCommand} --session "ses_generated"`,
      sessionId: 'ses_generated',
    });
  });

  it('inserts the selector before the first argument terminator', () => {
    expect(resolveOpenCodeLaunchCommand({
      baseCommand: 'opencode --auto -- --session positional',
      allocateSessionId: () => 'ses_generated',
    })).toEqual({
      commandToRun: 'opencode --auto --session "ses_generated" -- --session positional',
      sessionId: 'ses_generated',
    });
  });

  it.each([
    ['a comment', 'opencode --auto # note'],
    ['a command separator', 'opencode --auto; echo done'],
    ['a pipe', 'opencode --auto | echo done'],
    ['a background operator', 'opencode --auto &'],
    ['a redirect', 'opencode --auto > output.txt'],
    ['an unescaped newline', 'opencode --auto\necho done'],
    ['a parameter expansion', 'opencode --model $MODEL'],
    ['a parameter expansion in double quotes', 'opencode --model "$MODEL"'],
    ['a command substitution', 'opencode --model `get-model`'],
    ['a glob expansion', 'opencode --model *'],
    ['a tilde expansion', 'opencode --model ~/model'],
  ])('rejects unsupported shell syntax: %s', (_reason, baseCommand) => {
    expect(() => resolveOpenCodeLaunchCommand({
      baseCommand,
      allocateSessionId: () => 'ses_generated',
    })).toThrow();
  });

  it.each([
    ['escaped trailing space', 'opencode --model large\\ ', 'opencode --model large\\  --session "ses_generated"'],
    ['escaped trailing tab', 'opencode --model large\\\t', 'opencode --model large\\\t --session "ses_generated"'],
  ])('separates an inserted selector after %s', (_reason, baseCommand, commandToRun) => {
    expect(resolveOpenCodeLaunchCommand({
      baseCommand,
      allocateSessionId: () => 'ses_generated',
    })).toEqual({ commandToRun, sessionId: 'ses_generated' });
  });

  it.each([
    'opencode --continue',
    'opencode --continue=ses_old',
    'opencode --continue --session ses_current',
    'opencode --session ses_current --continue=ses_old',
  ])('rejects the forbidden continue option: %s', (baseCommand) => {
    expect(() => resolveOpenCodeLaunchCommand({ baseCommand })).toThrow();
  });

  it('allows continue text after the argument terminator', () => {
    expect(resolveOpenCodeLaunchCommand({
      baseCommand: 'opencode -- --continue',
      allocateSessionId: () => 'ses_generated',
    })).toEqual({
      commandToRun: 'opencode --session "ses_generated" -- --continue',
      sessionId: 'ses_generated',
    });
  });

  it.each([
    'opencode --session "ses_command\n"',
    "opencode --session 'ses_command\r'",
  ])('rejects a selector operand with a trailing line terminator: %s', (baseCommand) => {
    expect(() => resolveOpenCodeLaunchCommand({ baseCommand })).toThrow();
  });

  it.each(['\n', '\r', '\u2028', '\u2029'])('rejects an allocated id with a trailing line terminator', (terminator) => {
    expect(() => resolveOpenCodeLaunchCommand({
      baseCommand: 'opencode --auto',
      allocateSessionId: () => `ses_generated${terminator}`,
    })).toThrow();
  });

  it.each([
    ['a missing operand', 'opencode --session'],
    ['an empty equals operand', 'opencode --session='],
    ['a malformed id', 'opencode --session ses_bad-id'],
    ['an unsupported short equals form', 'opencode -s=ses_badform'],
    ['two identical selectors', 'opencode --session ses_same -s ses_same'],
    ['two conflicting selectors', 'opencode --session ses_one --session=ses_two'],
    ['an unmatched quote', 'opencode --model "unfinished'],
  ])('rejects %s', (_reason, baseCommand) => {
    expect(() => resolveOpenCodeLaunchCommand({
      baseCommand,
      allocateSessionId: () => 'ses_generated',
    })).toThrow();
  });

  it('rejects a selector that differs from the persisted id', () => {
    expect(() => resolveOpenCodeLaunchCommand({
      baseCommand: 'opencode --session ses_command',
      persistedSessionId: 'ses_persisted',
    })).toThrow();
  });
});
