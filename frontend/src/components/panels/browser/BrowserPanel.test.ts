import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './browserUrl';
import { hasFileProtocol } from '../../../../../shared/utils/browserUrl';

describe('browser file protocol selection', () => {
  it.each(['file:///tmp/index.html', 'FILE:///tmp/index.html', ' \tFiLe:///tmp/index.html', 'fI\tLe:///tmp/index.html'])('recognizes %j as a file URL', (url) => {
    expect(hasFileProtocol(url)).toBe(true);
  });
  it.each([undefined, '', 'https://example.com/file:', 'not a URL'])('does not classify %j as a file URL', (url) => {
    expect(hasFileProtocol(url)).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('preserves file URLs for local HTML previews', () => {
    expect(normalizeUrl('file:///tmp/Pane%20Preview/index.html')).toBe(
      'file:///tmp/Pane%20Preview/index.html',
    );
  });

  it('keeps existing web URL behavior', () => {
    expect(normalizeUrl('localhost:4173')).toBe('http://localhost:4173');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });
});
