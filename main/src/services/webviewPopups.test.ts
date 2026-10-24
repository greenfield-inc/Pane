import { describe, expect, it, vi } from 'vitest';
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron';
import { routeWebviewPopups } from './webviewPopups';

type OpenHandler = (details: Pick<HandlerDetails, 'url' | 'disposition'>) => WindowOpenHandlerResponse;

function setup(registered: boolean) {
  let handler: OpenHandler | undefined;
  const wvContents = {
    id: 7,
    setWindowOpenHandler: (next: OpenHandler) => { handler = next; },
    on: vi.fn(),
    once: vi.fn(),
  };
  const routing = {
    contextOf: vi.fn(() => (registered ? { panelId: 'panel-1', sessionId: 'session-1' } : undefined)),
    openBrowserTab: vi.fn(),
    openExternal: vi.fn(),
  };
  routeWebviewPopups(wvContents, routing);
  if (!handler) throw new Error('routeWebviewPopups did not install a window open handler');
  return { open: handler, routing };
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
});
