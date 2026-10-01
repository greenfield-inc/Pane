import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { parseSideBySideName, sideBySideDataDir, sideBySideUserDataDir } from './sideBySide';

describe('side-by-side builds', () => {
  it('reads the name electron-builder extraMetadata writes into the packaged package.json', () => {
    expect(parseSideBySideName(JSON.stringify({ name: 'Pane', version: '2.4.141-rc.1.gabc', paneSideBySide: 'cloudtest' }))).toBe('cloudtest');
  });

  it('treats a package.json without the field as a normal build', () => {
    expect(parseSideBySideName(JSON.stringify({ name: 'Pane', version: '2.4.141' }))).toBeNull();
    expect(parseSideBySideName('not json')).toBeNull();
  });

  it('rejects names that would escape the home directory or be empty', () => {
    for (const name of ['', '../pane', 'a/b', 'Cloud Test', '.pane', 'x'.repeat(33)]) {
      expect(parseSideBySideName(JSON.stringify({ paneSideBySide: name }))).toBeNull();
    }
  });

  it('keeps the data directory and the Chromium profile away from the installed Pane', () => {
    const dataDir = sideBySideDataDir('cloudtest', '/home/red');
    expect(dataDir).toBe(join('/home/red', '.pane_cloudtest'));
    expect(dataDir).not.toBe(join('/home/red', '.pane'));
    expect(sideBySideUserDataDir(dataDir)).toBe(join(dataDir, 'chromium-profile'));
  });
});
