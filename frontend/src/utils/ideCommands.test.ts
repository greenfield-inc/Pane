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
  const save = (projectCommand: string, wasShared: boolean, shared: boolean, currentDefault?: string) =>
    nextDefaultIdeCommand({ projectCommand, wasShared, shared, currentDefault });

  it('shares the project command while the toggle is on', () => {
    expect(save(' idea . ', false, true)).toBe('idea .');
    expect(save('idea .', false, true, 'code .')).toBe('idea .');
    expect(save('zed .', true, true, 'idea .')).toBe('zed .');
  });

  it('leaves the default alone unless the toggle changes it', () => {
    expect(save('idea .', true, true, 'idea .')).toBeUndefined();
    expect(save('', true, true, 'idea .')).toBeUndefined();
    expect(save('zed .', false, false, 'zed .')).toBeUndefined();
    expect(save('subl .', false, false, 'idea .')).toBeUndefined();
  });

  it('clears the default when the toggle is turned off', () => {
    expect(save('idea .', true, false, 'idea .')).toBe('');
    expect(save('idea .', true, false, undefined)).toBeUndefined();
  });
});
