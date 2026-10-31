import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { ListeningPortsSnapshot } from '@shared/types/listeningPorts';

import { browserPage, htmlFromBase64, reloadFile, splitAddress } from './browserPage';

const on: ListeningPortsSnapshot = {
  host: 'studio-mac',
  ports: [
    { port: 5173, pid: 1, process: 'node', group: 'pane-terminal', kind: 'web', phoneUrl: 'https://studio-mac.tail1.ts.net:44301' },
    { port: 3000, pid: 2, process: 'node', group: 'pane-terminal', kind: 'web' },
  ],
  phone: { state: 'on', filesUrl: 'https://studio-mac.tail1.ts.net:44300' },
};
const off: ListeningPortsSnapshot = { ...on, phone: { state: 'off', reason: 'a password protects this computer' } };

describe('browserPage', () => {
  it('loads a dev server through its phone address, and opens the same address in Safari', () => {
    expect(browserPage('http://localhost:5173/checkout', { ports: on }, 'panel-1')).toEqual({
      kind: 'web',
      src: 'https://studio-mac.tail1.ts.net:44301/checkout',
      address: 'localhost:5173/checkout',
    });
  });

  it('loads a public page directly', () => {
    expect(browserPage('https://example.com/a', { ports: off }, 'panel-1')).toMatchObject({ kind: 'web', src: 'https://example.com/a' });
  });

  it('loads an HTML file from the files address while phone pages are on, and reads it through the computer otherwise', () => {
    expect(browserPage('file:///Users/you/status.html', { ports: on }, 'panel-1')).toMatchObject({
      kind: 'web', src: 'https://studio-mac.tail1.ts.net:44300/file/panel-1/status.html',
    });
    expect(browserPage('file:///Users/you/status.html', { ports: off }, 'panel-1')).toEqual({
      kind: 'file', url: 'file:///Users/you/status.html', address: 'status.html',
    });
    expect(browserPage('file:///Users/you/status.html', { ports: null }, 'panel-1')).toMatchObject({ kind: 'file' });
  });

  it('says nothing listens when the dev server is down', () => {
    expect(browserPage('http://localhost:8080/', { ports: on }, 'panel-1')).toMatchObject({ kind: 'refused', port: 8080, host: 'studio-mac' });
  });

  it('says why the computer serves no pages to phones', () => {
    expect(browserPage('http://localhost:5173/', { ports: off }, 'panel-1')).toMatchObject({
      kind: 'pages-off', host: 'studio-mac', reason: 'a password protects this computer',
    });
  });

  it('waits while the ports are read and while the computer gives a port its phone address', () => {
    expect(browserPage('http://localhost:5173/', { ports: null }, 'panel-1')).toMatchObject({ kind: 'loading' });
    expect(browserPage('http://localhost:3000/', { ports: on }, 'panel-1')).toMatchObject({ kind: 'loading', request: 3000 });
  });

  it('asks for an update when the computer predates phone pages, and still opens files and public pages', () => {
    expect(browserPage('http://localhost:5173/', { ports: null, olderPane: true }, 'panel-1')).toMatchObject({ kind: 'update' });
    expect(browserPage('file:///Users/you/status.html', { ports: null, olderPane: true }, 'panel-1')).toMatchObject({ kind: 'file' });
    expect(browserPage('https://example.com/', { ports: null, olderPane: true }, 'panel-1')).toMatchObject({ kind: 'web' });
  });

  it('asks for an address when the tab has none, and flags one that is not a URL', () => {
    expect(browserPage('', { ports: on }, 'panel-1')).toEqual({ kind: 'empty', address: '' });
    expect(browserPage('not a url', { ports: on }, 'panel-1')).toMatchObject({ kind: 'invalid', address: 'not a url' });
  });
});

describe('splitAddress', () => {
  it('splits the host from the path, so the bar can dim the path', () => {
    expect(splitAddress('localhost:5173/checkout?step=2')).toEqual(['localhost:5173', '/checkout?step=2']);
    expect(splitAddress('localhost:5173/')).toEqual(['localhost:5173', '']);
    expect(splitAddress('https://example.com/a')).toEqual(['example.com', '/a']);
    expect(splitAddress('status.html')).toEqual(['status.html', '']);
  });
});

describe('htmlFromBase64', () => {
  it('decodes the UTF-8 file the computer sends', () => {
    expect(htmlFromBase64('Y2Fmw6kg4oCU')).toBe('café —');
  });
});

describe('reloadFile', () => {
  it('reads the HTML file again on Reload, even while the last read is still fresh', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
    const key = ['studio-mac', 'panels:read-browser-file', 'panel-1', 'file:///status.html'];
    let version = 'status-v1';
    const reads: string[] = [];
    const queryFn = () => {
      reads.push(version);
      return Promise.resolve(version);
    };
    // The tab's file view, mounted; Reload remounts it.
    const watch = () => {
      const observer = new QueryObserver(queryClient, { queryKey: key, queryFn });
      return { observer, stop: observer.subscribe(() => {}) };
    };
    const first = watch();
    await vi.waitFor(() => expect(first.observer.getCurrentResult().data).toBe('status-v1'));
    version = 'status-v2';
    first.stop();

    await reloadFile(queryClient, key);
    const second = watch();
    await vi.waitFor(() => expect(second.observer.getCurrentResult().data).toBe('status-v2'));
    second.stop();
    expect(reads).toEqual(['status-v1', 'status-v2']);
  });
});
