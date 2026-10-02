import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { windowsPathToWSLMount } from '../utils/wslUtils';
import { sessionRuntimePath, sessionWSLContext } from './sessionRuntime';

describe('Session runtime paths', () => {
  const runtime = { runtime: 'wsl' as const, wslDistribution: 'Ubuntu' };
  it('resolves a relative Pane directory before translating it', () => {
    expect(sessionRuntimePath(path.join('.pane-test', 'sessions', 'one'), runtime))
      .toBe(windowsPathToWSLMount(path.resolve('.pane-test', 'sessions', 'one')));
  });
  it('translates host paths and retains the chosen distro for terminal restoration', () => {
    expect(sessionRuntimePath('C:\\Users\\Ada Lovelace\\.pane', runtime)).toBe('/mnt/c/Users/Ada Lovelace/.pane');
    expect(sessionRuntimePath('C:\\Users\\Ada\\.pane', { runtime: 'windows' })).toBe('C:\\Users\\Ada\\.pane');
    expect(sessionWSLContext(runtime, 'D:\\Pane\\sessions\\one')).toEqual({ enabled: true, distribution: 'Ubuntu', linuxPath: '/mnt/d/Pane/sessions/one' });
    expect(sessionRuntimePath('\\\\wsl.localhost\\Ubuntu\\home\\ada', runtime)).toBe('/home/ada');
    expect(() => sessionRuntimePath('\\\\wsl.localhost\\Debian\\home\\ada', runtime)).toThrow('distribution');
  });
});
