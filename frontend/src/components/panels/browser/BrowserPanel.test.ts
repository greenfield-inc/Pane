import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './browserUrl';
import { hasFileProtocol, remapLoopbackPort } from '../../../../../shared/utils/browserUrl';

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

describe('remapLoopbackPort', () => {
  // The host's 5173 is tunnelled to 5174 on this desktop; its 3000 kept its number.
  const hostToLocal = new Map([[5173, 5174], [3000, 3000]]);
  const localToHost = new Map([[5174, 5173], [3000, 3000]]);

  it('points a host page at the port this desktop reaches it on, keeping path, query and hash', () => {
    expect(remapLoopbackPort('http://localhost:5173/app/?q=1#top', hostToLocal)).toBe('http://localhost:5174/app/?q=1#top');
    expect(remapLoopbackPort('http://127.0.0.1:5173/', hostToLocal)).toBe('http://127.0.0.1:5174/');
    expect(remapLoopbackPort('http://[::1]:5173/', hostToLocal)).toBe('http://[::1]:5174/');
  });

  it('maps a page this desktop navigated to back to the host address it stands for', () => {
    expect(remapLoopbackPort('http://localhost:5174/settings', localToHost)).toBe('http://localhost:5173/settings');
  });

  it('leaves URLs alone when the port kept its number, is not tunnelled, or is not on loopback', () => {
    expect(remapLoopbackPort('http://localhost:3000/', hostToLocal)).toBe('http://localhost:3000/');
    expect(remapLoopbackPort('http://localhost:8080/', hostToLocal)).toBe('http://localhost:8080/');
    expect(remapLoopbackPort('https://example.com:5173/', hostToLocal)).toBe('https://example.com:5173/');
    expect(remapLoopbackPort('file:///tmp/index.html', hostToLocal)).toBe('file:///tmp/index.html');
    expect(remapLoopbackPort('not a url', hostToLocal)).toBe('not a url');
  });

  it('maps a loopback URL without a port by its scheme\'s default port', () => {
    expect(remapLoopbackPort('http://localhost/', new Map([[80, 8080]]))).toBe('http://localhost:8080/');
  });
});
