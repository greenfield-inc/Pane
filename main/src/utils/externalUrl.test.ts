import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import { externalUrlOrNull, toExternalUrl } from './externalUrl';

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
