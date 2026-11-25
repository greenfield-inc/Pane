import { describe, expect, it, vi } from 'vitest';
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import { routeWebviewPopups } from './webviewPopups';

type OpenHandler = (details: Pick<HandlerDetails, 'url' | 'disposition'>) => WindowOpenHandlerResponse;

type NavigateHandler = (event: { preventDefault: () => void }, url: string, isInPlace?: boolean, isMainFrame?: boolean) => void;

/** The members of a popup's BrowserWindow that routeWebviewPopups uses. */
interface PopupWindow {
  isDestroyed(): boolean;
  close(): void;
  webContents: { on(event: string, listener: NavigateHandler): void };
}

function setup(registered: boolean, pageUrl = 'https://example.com/', extra: Partial<Parameters<typeof routeWebviewPopups>[1]> = {}) {
  let handler: OpenHandler | undefined;
  let navigate: NavigateHandler | undefined;
  let redirect: NavigateHandler | undefined;
  let createdWindow: ((window: PopupWindow) => void) | undefined;
  const wvContents = {
    id: 7,
    getURL: () => pageUrl,
    setWindowOpenHandler: (next: OpenHandler) => { handler = next; },
    on: vi.fn((event: string, listener: NavigateHandler & ((window: PopupWindow) => void)) => {
      if (event === 'will-navigate') navigate = listener;
      if (event === 'will-redirect') redirect = listener;
      if (event === 'did-create-window') createdWindow = listener;
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
  /** Chromium made a popup window; returns its navigation, which says whether it went ahead, and whether it closed. */
  const popupWindow = () => {
    const listeners = new Map<string, NavigateHandler>();
    const window = { isDestroyed: () => false, close: vi.fn(), webContents: { on: (event: string, listener: NavigateHandler) => { listeners.set(event, listener); } } };
    createdWindow?.(window);
    const navigateTo = (url: string): boolean => {
      let prevented = false;
      listeners.get('will-navigate')?.({ preventDefault: () => { prevented = true; } }, url);
      return !prevented;
    };
    return { navigateTo, close: window.close };
  };
  return { open: handler, follow, redirectTo, popupWindow, routing };
}

const GOOGLE_REFUSED = 'https://accounts.google.com/v3/signin/rejected?rrk=46&hl=en';
// Google's OAuth error page for an embedded browser; authError is base64 of the error, code first.
const GOOGLE_DISALLOWED = 'https://accounts.google.com/signin/oauth/error?authError=ChNkaXNhbGxvd2VkX3VzZXJhZ2VudBJkR29vZ2xl&client_id=1';

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

  it('lets Google sign in inside the tab and in its popups, as Continue with Google does', () => {
    const { follow, redirectTo, open, routing } = setup(true, 'https://www.reddit.com/login/');
    const signIn = 'https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com';
    expect(follow(signIn)).toBe(true);
    expect(redirectTo('https://accounts.google.com/o/oauth2/v2/auth?client_id=1&display=popup', true)).toBe(true);
    expect(open({ url: 'https://accounts.google.com/gsi/select?client_id=1', disposition: 'new-window' }).action).toBe('allow');
    expect(routing.refuseSignIn).not.toHaveBeenCalled();
    expect(routing.openExternal).not.toHaveBeenCalled();
  });

  it.each([GOOGLE_REFUSED, GOOGLE_DISALLOWED])('stops at Google\'s refusal %s and offers the page the tab is on', (refusal) => {
    const { follow, redirectTo, routing } = setup(true, 'https://www.reddit.com/login/');
    expect(follow(refusal)).toBe(false);
    expect(redirectTo(refusal, true)).toBe(false);
    expect(routing.refuseSignIn).toHaveBeenCalledWith({ url: 'https://www.reddit.com/login/', site: 'Google', panelId: 'panel-1' });
    // The person chooses: nothing opens until they press Open this page in your browser.
    expect(routing.openExternal).not.toHaveBeenCalled();
  });

  it('lets Google\'s other sign-in errors show in the tab', () => {
    const { follow, routing } = setup(true);
    expect(follow('https://accounts.google.com/signin/oauth/error?authError=Cg9pbnZhbGlkX3JlcXVlc3Q&client_id=1')).toBe(true);
    expect(routing.refuseSignIn).not.toHaveBeenCalled();
  });

  it('closes a sign-in popup Google refuses and offers its opener\'s page, never the popup\'s', () => {
    const { open, popupWindow, routing } = setup(true, 'https://www.reddit.com/login/');
    expect(open({ url: 'https://accounts.google.com/gsi/select?client_id=1', disposition: 'new-window' }).action).toBe('allow');
    const popup = popupWindow();
    expect(popup.navigateTo('https://accounts.google.com/v3/signin/identifier?client_id=1')).toBe(true);
    expect(popup.close).not.toHaveBeenCalled();
    expect(popup.navigateTo(GOOGLE_REFUSED)).toBe(false);
    expect(popup.close).toHaveBeenCalled();
    expect(routing.refuseSignIn).toHaveBeenCalledWith({ url: 'https://www.reddit.com/login/', site: 'Google', panelId: 'panel-1' });
  });

  it('offers the refused sign-in itself when the tab opened straight onto it', () => {
    const { follow, routing } = setup(true, 'about:blank');
    expect(follow(GOOGLE_REFUSED)).toBe(false);
    expect(routing.refuseSignIn).toHaveBeenCalledWith({ url: GOOGLE_REFUSED, site: 'Google', panelId: 'panel-1' });
  });

  it.each([
    ['https://signin.aws.amazon.com/signin?redirect_uri=https%3A%2F%2Fconsole.aws.amazon.com', 'AWS'],
    ['https://us-east-1.signin.aws/platform/login', 'AWS'],
    ['https://example.com/auth/callback?error=disallowed_useragent', 'Google'],
  ])('names %s as a sign-in %s refuses inside apps, offering the page the tab is on', (url, site) => {
    const { follow, routing } = setup(true);
    expect(follow(url)).toBe(false);
    expect(routing.refuseSignIn).toHaveBeenCalledWith({ url: 'https://example.com/', site, panelId: 'panel-1' });
  });

  it('opens a sign-in popup as a tab beside its opener when the opener\'s popups become tabs', () => {
    const popupPage = { id: 99 };
    const createPopup = vi.fn(() => popupPage);
    const { open, routing } = setup(true, 'https://example.com/', { popupTab: () => createPopup });
    const answer = open({ url: 'https://accounts.example.com/authorize', disposition: 'new-window' });
    if (answer.action !== 'allow' || !answer.createWindow) throw new Error(`expected a popup Pane creates itself, got ${JSON.stringify(answer)}`);
    const options = { width: 500, height: 600 };
    expect(answer.createWindow(options)).toBe(popupPage);
    expect(createPopup).toHaveBeenCalledWith({ url: 'https://accounts.example.com/authorize', options, opener: { panelId: 'panel-1', sessionId: 'session-1' }, openerUrl: 'https://example.com/' });
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
