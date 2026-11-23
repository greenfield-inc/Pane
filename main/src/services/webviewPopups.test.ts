import { describe, expect, it, vi } from 'vitest';
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import { routeWebviewPopups } from './webviewPopups';

type OpenHandler = (details: Pick<HandlerDetails, 'url' | 'disposition'>) => WindowOpenHandlerResponse;

type NavigateHandler = (event: { preventDefault: () => void }, url: string, isInPlace?: boolean, isMainFrame?: boolean) => void;

function setup(registered: boolean, pageUrl = 'https://example.com/', extra: Partial<Parameters<typeof routeWebviewPopups>[1]> = {}) {
  let handler: OpenHandler | undefined;
  let navigate: NavigateHandler | undefined;
  let redirect: NavigateHandler | undefined;
  const wvContents = {
    id: 7,
    getURL: () => pageUrl,
    setWindowOpenHandler: (next: OpenHandler) => { handler = next; },
    on: vi.fn((event: string, listener: NavigateHandler) => {
      if (event === 'will-navigate') navigate = listener;
      if (event === 'will-redirect') redirect = listener;
    }),
    once: vi.fn(),
  };
  const routing = {
    contextOf: vi.fn(() => (registered ? { panelId: 'panel-1', sessionId: 'session-1' } : undefined)),
    openBrowserTab: vi.fn(),
    openExternal: vi.fn(),
    openPaneLink: vi.fn(),
    offerApp: vi.fn(),
    refuseSignIn: vi.fn(),
    ...extra,
  };
  routeWebviewPopups(wvContents, routing);
  if (!handler || !navigate || !redirect) throw new Error('routeWebviewPopups did not install its handlers');
  const click = navigate;
  const redirected = redirect;
  /** A link click in the page; returns whether the page itself navigated. */
  const follow = (url: string): boolean => {
    let prevented = false;
    click({ preventDefault: () => { prevented = true; } }, url);
    return !prevented;
  };
  /** A server redirect, in the page itself or in a frame inside it; returns whether it went ahead. */
  const redirectTo = (url: string, isMainFrame: boolean): boolean => {
    let prevented = false;
    redirected({ preventDefault: () => { prevented = true; } }, url, false, isMainFrame);
    return !prevented;
  };
  return { open: handler, follow, redirectTo, routing };
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

  it('asks the person before a page opens an app, and never opens it itself', () => {
    const { open, routing } = setup(true);
    expect(open({ url: 'zoommtg://zoom.us/join?confno=123', disposition: 'foreground-tab' })).toEqual({ action: 'deny' });
    expect(routing.offerApp).toHaveBeenCalledWith({ url: 'zoommtg://zoom.us/join?confno=123', panelId: 'panel-1' });
    expect(routing.openExternal).not.toHaveBeenCalled();
  });

  it('keeps a Google sign-in out of the tab and offers the system browser, from a link, a redirect or a popup', () => {
    const { follow, redirectTo, open, routing } = setup(true);
    const signIn = 'https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com';
    expect(follow(signIn)).toBe(false);
    expect(redirectTo(signIn, true)).toBe(false);
    expect(open({ url: signIn, disposition: 'new-window' })).toEqual({ action: 'deny' });
    expect(routing.refuseSignIn).toHaveBeenCalledTimes(3);
    expect(routing.refuseSignIn).toHaveBeenCalledWith({ url: signIn, site: 'Google', panelId: 'panel-1' });
    // The person chooses: nothing opens until they press Open in your browser.
    expect(routing.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['https://signin.aws.amazon.com/signin?redirect_uri=https%3A%2F%2Fconsole.aws.amazon.com', 'AWS'],
    ['https://us-east-1.signin.aws/platform/login', 'AWS'],
    ['https://example.com/auth/callback?error=disallowed_useragent', 'Google'],
  ])('names %s as a sign-in %s refuses inside apps', (url, site) => {
    const { follow, routing } = setup(true);
    expect(follow(url)).toBe(false);
    expect(routing.refuseSignIn).toHaveBeenCalledWith({ url, site, panelId: 'panel-1' });
  });

  it('opens a sign-in popup as a tab beside its opener when the opener\'s popups become tabs', () => {
    const popupPage = { id: 99 };
    const createPopup = vi.fn(() => popupPage);
    const { open, routing } = setup(true, 'https://example.com/', { popupTab: () => createPopup });
    const answer = open({ url: 'https://accounts.example.com/authorize', disposition: 'new-window' });
    if (answer.action !== 'allow' || !answer.createWindow) throw new Error(`expected a popup Pane creates itself, got ${JSON.stringify(answer)}`);
    const options = { width: 500, height: 600 };
    expect(answer.createWindow(options)).toBe(popupPage);
    expect(createPopup).toHaveBeenCalledWith({ url: 'https://accounts.example.com/authorize', options, opener: { panelId: 'panel-1', sessionId: 'session-1' } });
    expect(routing.openBrowserTab).not.toHaveBeenCalled();
  });

  it.each([
    // Console federation and the OAuth hop after a sign-in carry no sign-in form.
    'https://signin.aws.amazon.com/federation?Action=login',
    'https://signin.aws.amazon.com/oauth?code=abc',
    // A page that only mentions Google's error is not that error.
    'https://example.com/search?q=disallowed_useragent',
  ])('lets %s load', (url) => {
    const { follow, routing } = setup(true);
    expect(follow(url)).toBe(true);
    expect(routing.refuseSignIn).not.toHaveBeenCalled();
  });

  it('leaves a Google sign-in button inside another site\'s page alone', () => {
    const { redirectTo, routing } = setup(true);
    expect(redirectTo('https://accounts.google.com/gsi/button?client_id=1', false)).toBe(true);
    expect(routing.refuseSignIn).not.toHaveBeenCalled();
  });

  it('lets ordinary links navigate the page', () => {
    const { follow, routing } = setup(true, 'file:///tmp/page.html');
    expect(follow('https://example.com/docs')).toBe(true);
    expect(routing.openPaneLink).not.toHaveBeenCalled();
  });
});
