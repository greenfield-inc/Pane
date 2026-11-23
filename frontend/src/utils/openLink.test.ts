import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkDestination, openLink, swapsDestination } from './openLink';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('linkDestination', () => {
  it('opens a web link from a Pane in a Pane tab by default', () => {
    expect(linkDestination('https://github.com/acme/app/pull/12', { paneId: 'pane-1' })).toBe('pane');
    expect(linkDestination('http://localhost:5173/', { paneId: 'pane-1', openIn: 'pane' })).toBe('pane');
  });

  it('sends every link to the system browser when Settings > Links says so', () => {
    expect(linkDestination('https://github.com/acme/app/pull/12', { paneId: 'pane-1', openIn: 'system' })).toBe('system');
  });

  it('opens a Cmd-click or Ctrl-click in the place a plain click does not', () => {
    expect(linkDestination('https://github.com/acme/app/pull/12', { paneId: 'pane-1', swap: true })).toBe('system');
    expect(linkDestination('https://github.com/acme/app/pull/12', { paneId: 'pane-1', openIn: 'system', swap: true })).toBe('pane');
  });

  it('sends a link that is not http or https to the system, clicked either way', () => {
    for (const url of ['mailto:team@example.com', 'zoommtg://zoom.us/join?confno=1', 'file:///etc/hosts', 'not a url']) {
      expect(linkDestination(url, { paneId: 'pane-1' })).toBe('system');
      expect(linkDestination(url, { paneId: 'pane-1', openIn: 'system', swap: true })).toBe('system');
    }
  });

  it('sends a link with no Pane, such as one from Pane\'s own menus, to the system browser, clicked either way', () => {
    expect(linkDestination('https://runpane.com/docs', {})).toBe('system');
    expect(linkDestination('https://runpane.com/docs', { openIn: 'system', swap: true })).toBe('system');
  });
});

describe('swapsDestination', () => {
  it('is Cmd on macOS and Ctrl elsewhere', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(swapsDestination({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(swapsDestination({ metaKey: false, ctrlKey: true })).toBe(false);
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(swapsDestination({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(swapsDestination({ metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe('openLink', () => {
  const stubElectron = (invoke = vi.fn(() => Promise.resolve())) => {
    const openExternal = vi.fn(() => Promise.resolve({ success: true }));
    vi.stubGlobal('window', { electronAPI: { invoke, openExternal } });
    return { invoke, openExternal };
  };

  it('opens a plain click in a browser tab of its Pane, beside the conversation', async () => {
    const { invoke, openExternal } = stubElectron();
    await openLink('https://github.com/acme/app/pull/12', 'pane-1');
    expect(invoke).toHaveBeenCalledWith('runpane:panels:open', { paneId: 'pane-1', url: 'https://github.com/acme/app/pull/12', placement: 'split', source: 'user' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens a Cmd-click or Ctrl-click in the system browser', async () => {
    const { invoke, openExternal } = stubElectron();
    await openLink('https://github.com/acme/app/pull/12', 'pane-1', { swap: true });
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/12');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls back to the system browser when the Pane tab cannot open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { openExternal } = stubElectron(vi.fn(() => Promise.reject(new Error('Pane is gone'))));
    await openLink('https://github.com/acme/app/pull/12', 'pane-1');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/12');
  });
});
