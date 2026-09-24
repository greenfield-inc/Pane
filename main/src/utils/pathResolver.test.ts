import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandUserRepoPath } from './pathResolver';

const homeDir = path.join(os.tmpdir(), 'pane-expand-home');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0).reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('expandUserRepoPath', () => {
  it('expands a lone tilde to the home directory', () => {
    expect(expandUserRepoPath('~', { homeDir })).toBe(path.resolve(homeDir));
  });

  it('expands ~/ and ~\\ prefixes to home', () => {
    expect(expandUserRepoPath('~/src/pane', { homeDir })).toBe(path.resolve(homeDir, 'src/pane'));
    expect(expandUserRepoPath('~\\src\\pane', { homeDir })).toBe(path.resolve(homeDir, 'src', 'pane'));
  });

  it('trims whitespace before expanding', () => {
    expect(expandUserRepoPath('  ~/repo  ', { homeDir })).toBe(path.resolve(homeDir, 'repo'));
  });

  it('resolves relative paths against home instead of process.cwd()', () => {
    expect(expandUserRepoPath('src/pane', { homeDir })).toBe(path.resolve(homeDir, 'src/pane'));
    expect(expandUserRepoPath('./repo', { homeDir })).toBe(path.resolve(homeDir, 'repo'));
  });

  it('normalizes existing absolute paths without treating them as home-relative', () => {
    const absolute = path.resolve(os.tmpdir(), 'pane-absolute-repo');
    expect(expandUserRepoPath(absolute, { homeDir })).toBe(absolute);
  });

  it('does not expand ~otheruser paths as another home', () => {
    expect(expandUserRepoPath('~other/repo', { homeDir })).toBe(path.resolve(homeDir, '~other/repo'));
  });

  it('leaves WSL UNC paths unchanged so parseWSLPath still matches', () => {
    const wslLocalhost = '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo';
    const wslDollar = '\\\\wsl$\\Debian\\home\\user\\repo';
    expect(expandUserRepoPath(wslLocalhost, { homeDir })).toBe(wslLocalhost);
    expect(expandUserRepoPath(wslDollar, { homeDir })).toBe(wslDollar);
  });

  it('returns an empty string for blank input', () => {
    expect(expandUserRepoPath('   ', { homeDir })).toBe('');
  });

  it('preserves the spelling of an existing directory', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-expand-real-'));
    tempDirs.push(realDir);
    expect(expandUserRepoPath(realDir, { homeDir })).toBe(path.resolve(realDir));
  });

  it.skipIf(process.platform === 'win32')('preserves an existing symlink spelling', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-expand-real-'));
    tempDirs.push(realDir);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-expand-link-'));
    tempDirs.push(linkParent);
    const linkPath = path.join(linkParent, 'alias');
    fs.symlinkSync(realDir, linkPath);

    expect(expandUserRepoPath(linkPath, { homeDir })).toBe(path.resolve(linkPath));
  });
});
