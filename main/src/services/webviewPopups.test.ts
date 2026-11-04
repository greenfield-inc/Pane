import { describe, expect, it, vi } from 'vitest';
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import { routeWebviewPopups } from './webviewPopups';

type OpenHandler = (details: Pick<HandlerDetails, 'url' | 'disposition'>) => WindowOpenHandlerResponse;

type NavigateHandler = (event: { preventDefault: () => void }, url: string) => void;

function setup(registered: boolean, pageUrl = 'https://example.com/') {
  let handler: OpenHandler | undefined;
  let navigate: NavigateHandler | undefined;
  const wvContents = {
    id: 7,
    getURL: () => pageUrl,
    setWindowOpenHandler: (next: OpenHandler) => { handler = next; },
    on: vi.fn((event: string, listener: NavigateHandler) => { if (event === 'will-navigate') navigate = listener; }),
    once: vi.fn(),
  };
  const routing = {
    contextOf: vi.fn(() => (registered ? { panelId: 'panel-1', sessionId: 'session-1' } : undefined)),
    openBrowserTab: vi.fn(),
    openExternal: vi.fn(),
    openPaneLink: vi.fn(),
  };
  routeWebviewPopups(wvContents, routing);
  if (!handler || !navigate) throw new Error('routeWebviewPopups did not install its handlers');
  const click = navigate;
  /** A link click in the page; returns whether the page itself navigated. */
  const follow = (url: string): boolean => {
    let prevented = false;
    click({ preventDefault: () => { prevented = true; } }, url);
    return !prevented;
  };
  return { open: handler, follow, routing };
}

describe('routeWebviewPopups', () => {
  it('opens an https link as a browser tab', () => {
    const { open, routing } = setup(true);
    expect(open({ url: 'https://example.com/', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect(routing.openBrowserTab).toHaveBeenCalledWith({ url: 'https://example.com/', sourceSessionId: 'session-1', sourcePanelId: 'panel-1' });
  });

  it('allows an https sign-in popup and about:blank popups', () => {
    const { open } = setup(true);
    expect(open({ url: 'https://accounts.example.com/', disposition: 'new-window' }).action).toBe('allow');
    expect(open({ url: 'about:blank', disposition: 'new-window' }).action).toBe('allow');
  });

  it.each([
    ['file:///Applications/Calculator.app', 'foreground-tab'],
    ['file:///Applications/Calculator.app', 'new-window'],
    ['vscode://file/etc/passwd', 'foreground-tab'],
    ['javascript:alert(1)', 'new-window'],
  ] as const)('denies %s (%s) without routing it anywhere', (url, disposition) => {
    for (const registered of [true, false]) {
      const { open, routing } = setup(registered);
      expect(open({ url, disposition })).toEqual({ action: 'deny' });
      expect(routing.openBrowserTab).not.toHaveBeenCalled();
      expect(routing.openExternal).not.toHaveBeenCalled();
    }
  });

  it('opens a pane:// link in a local page, such as Start here, through Pane', () => {
    const { follow, open, routing } = setup(true, 'file:///Users/me/.pane/migrate-to-pane/start-here.html');
    const link = 'pane://open?session=__orchestration_session_abc__';
    expect(follow(link)).toBe(false);
    expect(open({ url: link, disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect(routing.openPaneLink.mock.calls).toEqual([[link], [link]]);
  });

  it('ignores a pane:// link in a web page', () => {
    const { follow, open, routing } = setup(true, 'https://evil.example/');
    expect(follow('pane://open?session=x')).toBe(false);
    expect(open({ url: 'pane://open?session=x', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect(routing.openPaneLink).not.toHaveBeenCalled();
  });

  it('lets ordinary links navigate the page', () => {
    const { follow, routing } = setup(true, 'file:///tmp/page.html');
    expect(follow('https://example.com/docs')).toBe(true);
    expect(routing.openPaneLink).not.toHaveBeenCalled();
  });
});
