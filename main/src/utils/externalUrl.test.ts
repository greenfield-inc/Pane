import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import { externalUrlOrNull, toExternalUrl, toLocalPagePath } from './externalUrl';

describe('externalUrlOrNull', () => {
  it.each([
    ['http://localhost:4521/path?q=1', 'http://localhost:4521/path?q=1'],
    ['https://runpane.com/docs', 'https://runpane.com/docs'],
    ['mailto:hello@dcouple.ai', 'mailto:hello@dcouple.ai'],
  ])('allows %s', (input, expected) => {
    expect(externalUrlOrNull(input)).toBe(expected);
  });

  it('returns the normalized URL', () => {
    expect(externalUrlOrNull('  HTTPS://Example.COM')).toBe('https://example.com/');
  });

  it.each([
    ['a file: URL', 'file:///Applications/Calculator.app'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a javascript: URL with leading whitespace', ' javascript:alert(1)'],
    ['a custom app scheme', 'vscode://file/etc/passwd'],
    ['a macOS settings scheme', 'x-apple-systempreferences:com.apple.preference.security'],
    ['a flag-shaped value', '-a Calculator'],
    ['a bare absolute path', '/Applications/Calculator.app'],
    ['a bare relative path', 'docs/README.md'],
    ['an invalid URL', 'http://'],
    ['an empty string', ''],
  ])('refuses %s', (_label, input) => {
    expect(externalUrlOrNull(input)).toBeNull();
  });
});

describe('toExternalUrl', () => {
  it('returns an allowed URL', () => {
    expect(toExternalUrl('https://runpane.com')).toBe('https://runpane.com/');
  });

  it('throws ERR_EXTERNAL_URL_BLOCKED with a next step for a refused URL', () => {
    let thrown: unknown;
    try {
      toExternalUrl('file:///etc/passwd');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaneError);
    expect(thrown).toMatchObject({ code: 'ERR_EXTERNAL_URL_BLOCKED', next: expect.any(String) });
  });
});

describe.skipIf(process.platform === 'win32')('toLocalPagePath', () => {
  it.each([
    ['file:///Users/me/status.html', '/Users/me/status.html'],
    ['file:///Users/me/My%20Plan/index.HTM', '/Users/me/My Plan/index.HTM'],
  ])('allows %s', (input, expected) => {
    expect(toLocalPagePath(input)).toBe(expected);
  });

  it.each([
    ['an app bundle', 'file:///Applications/Calculator.app'],
    ['a shell script', 'file:///Users/me/run.command'],
    ['a file on another machine', 'file://server/share/page.html'],
    ['an http URL', 'http://localhost:5173/index.html'],
    ['a bare path', '/Users/me/status.html'],
  ])('refuses %s', (_label, input) => {
    expect(() => toLocalPagePath(input)).toThrow(PaneError);
  });
});

describe.runIf(process.platform === 'win32')('toLocalPagePath on Windows', () => {
  it.each([
    ['file:///C:/Users/me/status.html', 'C:\\Users\\me\\status.html'],
    ['file://wsl.localhost/Ubuntu/home/me/status.html', '\\\\wsl.localhost\\Ubuntu\\home\\me\\status.html'],
  ])('allows %s', (input, expected) => {
    expect(toLocalPagePath(input)).toBe(expected);
  });

  it('refuses a page on a network share', () => {
    expect(() => toLocalPagePath('file://server/share/page.html')).toThrow(PaneError);
  });
});
