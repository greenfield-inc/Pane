import { describe, expect, it } from 'vitest';
import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import { phoneMediaUrl, phonePage } from './phonePage';

const ports: ListeningPortsSnapshot = {
  host: 'parsas-macbook-pro',
  ports: [
    { port: 5173, pid: 1, process: 'node', group: 'pane-terminal', kind: 'web', phoneUrl: 'https://mac.tail3c2c57.ts.net:44301' },
    { port: 3000, pid: 2, process: 'next-server', group: 'pane-terminal', kind: 'web' },
    { port: 5432, pid: 3, process: 'postgres', group: 'other', kind: 'tcp' },
  ],
  phone: { state: 'on', filesUrl: 'https://mac.tail3c2c57.ts.net:44300' },
};

describe('phonePage', () => {
  it('opens a host dev server at its phone address, keeping path, query and hash', () => {
    expect(phonePage('http://localhost:5173/app/page?x=1#top', ports, 'panel-1')).toEqual({
      kind: 'frame',
      src: 'https://mac.tail3c2c57.ts.net:44301/app/page?x=1#top',
      address: 'localhost:5173/app/page?x=1#top',
      host: 'parsas-macbook-pro',
    });
    expect(phonePage('http://127.0.0.1:5173/', ports, 'panel-1')).toMatchObject({ src: 'https://mac.tail3c2c57.ts.net:44301/' });
    expect(phonePage('http://[::1]:5173', ports, 'panel-1')).toMatchObject({ src: 'https://mac.tail3c2c57.ts.net:44301/' });
  });

  it('opens a host HTML file from the files address, by the panel that holds it', () => {
    expect(phonePage('file:///Users/me/repo/report%20v2.html', ports, 'panel-1')).toEqual({
      kind: 'frame',
      src: 'https://mac.tail3c2c57.ts.net:44300/file/panel-1/report%20v2.html',
      address: 'report v2.html',
      host: 'parsas-macbook-pro',
    });
  });

  it('loads any other address as it is', () => {
    expect(phonePage('https://github.com/greenfield-inc/Pane', ports, 'panel-1')).toEqual({
      kind: 'frame',
      src: 'https://github.com/greenfield-inc/Pane',
      address: 'https://github.com/greenfield-inc/Pane',
    });
  });

  it('explains a host page the phone cannot open yet', () => {
    expect(phonePage('http://localhost:3000/', ports, 'panel-1')).toEqual({
      kind: 'unavailable',
      address: 'localhost:3000/',
      host: 'parsas-macbook-pro',
      reason: 'Pane is giving localhost:3000 a phone address…',
      request: 3000,
    });
    expect(phonePage('http://localhost:5432/', ports, 'panel-1')).toMatchObject({
      reason: 'localhost:5432 does not answer HTTP, so it opens only on desktops.',
    });
    expect(phonePage('http://localhost:8080/', ports, 'panel-1')).toMatchObject({
      reason: 'Nothing on parsas-macbook-pro listens on port 8080.',
    });
    expect(phonePage('http://localhost:5173/', { ...ports, phone: { state: 'off', reason: 'Tailscale is not installed' } }, 'panel-1')).toMatchObject({
      reason: 'Phone pages from parsas-macbook-pro are unavailable right now (Tailscale is not installed). Pane checks again every minute.',
    });
  });
});

describe('phoneMediaUrl', () => {
  it('serves a worktree file from the files address, one encoded segment per folder', () => {
    expect(phoneMediaUrl('docs/demo clips/intro#1.mp4', ports, 'session-1')).toEqual({
      url: 'https://mac.tail3c2c57.ts.net:44300/media/session-1/docs/demo%20clips/intro%231.mp4',
    });
    expect(phoneMediaUrl('assets\\logo.png', ports, 'session-1')).toEqual({
      url: 'https://mac.tail3c2c57.ts.net:44300/media/session-1/assets/logo.png',
    });
  });

  it('explains why media cannot load while phone pages are off', () => {
    expect(phoneMediaUrl('logo.png', { ...ports, phone: { state: 'off', reason: 'Tailscale is not installed' } }, 'session-1')).toEqual({
      reason: 'Phone pages from parsas-macbook-pro are unavailable right now (Tailscale is not installed). Pane checks again every minute.',
    });
  });
});
