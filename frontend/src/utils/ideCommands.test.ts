import { describe, expect, it } from 'vitest';
import { configuredIde, nextDefaultIdeCommand, resolveIdeCommand } from '../../../shared/utils/ideCommands';

describe('configuredIde', () => {
  it('prefers the project command, then the default for all projects', () => {
    expect(configuredIde('subl .', 'idea .')).toEqual({ command: 'subl .', source: 'project' });
    expect(configuredIde(null, 'idea .')).toEqual({ command: 'idea .', source: 'app' });
    expect(configuredIde('  ', ' idea . ')).toEqual({ command: 'idea .', source: 'app' });
    expect(configuredIde(undefined, '')).toBeUndefined();
  });
});

describe('resolveIdeCommand', () => {
  it('opens a built-in IDE by key, otherwise the configured IDE', () => {
    expect(resolveIdeCommand('cursor', 'subl .', undefined)).toBe('cursor .');
    expect(resolveIdeCommand('vscode', null, 'idea .')).toBe('code .');
    expect(resolveIdeCommand(undefined, null, 'idea .')).toBe('idea .');
    expect(resolveIdeCommand('unknown', 'subl .', 'idea .')).toBe('subl .');
    expect(resolveIdeCommand(undefined, null, undefined)).toBeUndefined();
  });
});

describe('nextDefaultIdeCommand', () => {
  it('sets the default when the project command is used for all projects', () => {
    expect(nextDefaultIdeCommand(' idea . ', true, undefined)).toBe('idea .');
    expect(nextDefaultIdeCommand('idea .', true, 'code .')).toBe('idea .');
  });

  it('leaves the default alone when nothing changes it', () => {
    expect(nextDefaultIdeCommand('idea .', true, 'idea .')).toBeUndefined();
    expect(nextDefaultIdeCommand('', true, 'idea .')).toBeUndefined();
    expect(nextDefaultIdeCommand('subl .', false, 'idea .')).toBeUndefined();
    expect(nextDefaultIdeCommand('', false, 'idea .')).toBeUndefined();
  });

  it('clears the default when its project stops using it for all projects', () => {
    expect(nextDefaultIdeCommand('idea .', false, 'idea .')).toBe('');
  });
});
