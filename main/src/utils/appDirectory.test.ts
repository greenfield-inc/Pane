import { afterEach, describe, expect, it } from 'vitest';
import { getAppDirectoryOverrideFromArgs } from './appDirectory';

describe('appDirectory CLI parsing', () => {
  it('parses pane-dir in both supported forms', () => {
    expect(getAppDirectoryOverrideFromArgs(['--pane-dir=/tmp/pane-a'])).toBe('/tmp/pane-a');
    expect(getAppDirectoryOverrideFromArgs(['--pane-dir', '/tmp/pane-b'])).toBe('/tmp/pane-b');
  });

  it('accepts the deprecated foozol-dir flags for backward compatibility', () => {
    expect(getAppDirectoryOverrideFromArgs(['--foozol-dir=/tmp/pane-c'])).toBe('/tmp/pane-c');
    expect(getAppDirectoryOverrideFromArgs(['--foozol-dir', '/tmp/pane-d'])).toBe('/tmp/pane-d');
  });

  it('returns undefined when no override flag is provided', () => {
    expect(getAppDirectoryOverrideFromArgs(['--verbose'])).toBeUndefined();
  });
});

describe('appDirectory process.argv parsing', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  // Packaged builds have no script path: user args start at argv[1].
  const packagedExe = 'C:\\Program Files\\Pane\\Pane.exe';
  // Dev builds run `electron .`, so user args start at argv[2].
  const devArgvPrefix = ['C:\\repo\\node_modules\\electron\\dist\\electron.exe', '.'];

  it.each([
    ['first', ['--pane-dir', '/tmp/pane-x', '--user-data-dir=/tmp/profile', '--verbose']],
    ['first, inline value', ['--pane-dir=/tmp/pane-x', '--user-data-dir=/tmp/profile']],
    ['middle', ['--verbose', '--pane-dir', '/tmp/pane-x', '--user-data-dir=/tmp/profile']],
    ['last', ['--user-data-dir=/tmp/profile', '--pane-dir', '/tmp/pane-x']],
    ['last, inline value', ['--user-data-dir=/tmp/profile', '--pane-dir=/tmp/pane-x']],
  ])('finds --pane-dir in the %s position of a packaged argv', (_position, userArgs) => {
    process.argv = [packagedExe, ...userArgs];
    expect(getAppDirectoryOverrideFromArgs()).toBe('/tmp/pane-x');
  });

  it.each([
    ['first', ['--pane-dir', '/tmp/pane-x', '--verbose']],
    ['middle', ['--verbose', '--pane-dir=/tmp/pane-x', '--user-data-dir=/tmp/profile']],
    ['last', ['--verbose', '--pane-dir', '/tmp/pane-x']],
  ])('finds --pane-dir in the %s position of a dev argv', (_position, userArgs) => {
    process.argv = [...devArgvPrefix, ...userArgs];
    expect(getAppDirectoryOverrideFromArgs()).toBe('/tmp/pane-x');
  });

  it('does not treat the executable or script path as an override', () => {
    process.argv = [packagedExe];
    expect(getAppDirectoryOverrideFromArgs()).toBeUndefined();
    process.argv = devArgvPrefix;
    expect(getAppDirectoryOverrideFromArgs()).toBeUndefined();
  });
});
