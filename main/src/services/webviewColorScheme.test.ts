import { describe, expect, it } from 'vitest';
import { setGuestColorScheme, type ColorSchemeGuest } from './webviewColorScheme';

interface Host { id: number }

function guest(host: Host, type = 'webview') {
  const sent: Array<{ method: string; params: unknown }> = [];
  let attached = false;
  const contents: ColorSchemeGuest<Host> = {
    getType: () => type,
    hostWebContents: host,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      sendCommand: async (method, params) => { sent.push({ method, params }); },
    },
  };
  return { contents, sent };
}

describe('setGuestColorScheme (D-163)', () => {
  it('sets a webview guest\'s prefers-color-scheme to Pane\'s theme', async () => {
    const host = { id: 1 };
    const { contents, sent } = guest(host);
    await setGuestColorScheme(host, contents, 'dark');
    await setGuestColorScheme(host, contents, 'light');
    expect(sent).toEqual([
      { method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] } },
      { method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: 'light' }] } },
    ]);
  });

  it('refuses anything but a webview that this window hosts, and a missing one', async () => {
    const host = { id: 1 };
    await expect(setGuestColorScheme(host, guest({ id: 2 }).contents, 'dark')).rejects.toMatchObject({ code: 'WEBVIEW_NOT_HOSTED' });
    await expect(setGuestColorScheme(host, guest(host, 'window').contents, 'dark')).rejects.toMatchObject({ code: 'WEBVIEW_NOT_HOSTED' });
    await expect(setGuestColorScheme(host, undefined, 'dark')).rejects.toMatchObject({ code: 'WEBVIEW_NOT_HOSTED' });
  });
});
