import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { ALLOWED_CDP_METHODS, PageDriver, type BrowserPageContents } from './pageDriver';

/** A page whose debugger records every method sent to it and opens a confirm() on a click. */
function recordingPage() {
  const sent: string[] = [];
  const debug = Object.assign(new EventEmitter(), {
    attached: false,
    attach() { this.attached = true; },
    isAttached() { return this.attached; },
    detach() { this.attached = false; },
    sendCommand: async (method: string, params?: { type?: string }) => {
      sent.push(method);
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        debug.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete it?' });
        return new Promise(() => undefined);
      }
      if (method === 'Page.handleJavaScriptDialog') debug.emit('message', {}, 'Page.javascriptDialogClosed', {});
      if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 2000 }, cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
      if (method === 'Runtime.evaluate') return { result: { value: 'Sign up' } };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 3 };
      return {};
    },
  });
  let reloads = 0;
  const page = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    getURL: () => 'http://localhost/',
    getTitle: () => 'Sign up',
    isLoading: () => false,
    isDevToolsOpened: () => false,
    devToolsWebContents: null,
    insertText: async () => undefined,
    capturePage: async () => ({ toPNG: () => Buffer.from('png'), getSize: () => ({ width: 800, height: 600 }) }),
    loadURL: async () => undefined,
    reload: () => { reloads += 1; page.emit('did-stop-loading'); },
    navigationHistory: { canGoBack: () => true, goBack: () => page.emit('did-stop-loading'), canGoForward: () => false, goForward: () => undefined },
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
      const method = /\)\.(\w+)\([^()]*\)$/.exec(code)?.[1];
      if (method === 'snapshot') return { snapshot: '- button "Delete" [ref=e1]', truncated: false, url: 'http://localhost/', title: 'Sign up' };
      if (method === 'point') return { x: 10, y: 20 };
      if (method === 'select') return ['ca'];
      if (method === 'check') return { met: true };
      return true;
    },
    debugger: debug,
  });
  // SAFETY: The fake implements every member the driver calls.
  return { page: page as unknown as BrowserPageContents, sent, reloads: () => reloads };
}

describe('page driver', () => {
  it('drives every verb with only its own debugger methods, and reloads through Electron', async () => {
    const { page, sent, reloads } = recordingPage();
    const driver = new PageDriver(page);
    await driver.snapshot();
    await driver.type('e1', 'ada@example.com', true, true);
    await driver.press('Meta+A', undefined);
    await driver.select('e1', ['Canada']);
    await driver.scroll(undefined, 0, 400);
    await driver.navigate({ history: 'back' });
    await driver.navigate({ history: 'reload' });
    await driver.wait({ text: 'Saved' }, 1_000);
    await driver.evaluate('document.title', undefined);
    await driver.upload('e1', ['/tmp/report.pdf']);
    await driver.screenshot(true);
    const clicked = await driver.click({ ref: 'e1' }, 'left', false);
    expect(clicked.dialog).toEqual({ type: 'confirm', message: 'Delete it?' });
    await driver.answerDialog(true, undefined);

    expect(sent.length).toBeGreaterThan(10);
    expect(sent.filter(method => !ALLOWED_CDP_METHODS.has(method))).toEqual([]);
    expect(sent.some(method => /^(Target|Browser|Storage|Network)\./.test(method) || method === 'Page.reload')).toBe(false);
    expect(reloads()).toBe(1);
  });

  it('holds a dialog: every other action fails until it is answered', async () => {
    const { page } = recordingPage();
    const driver = new PageDriver(page);
    await driver.snapshot();
    await driver.click({ ref: 'e1' }, 'left', false);
    await expect(driver.snapshot()).rejects.toMatchObject({ code: 'ERR_BROWSER_DIALOG_PENDING' });
    await expect(driver.type('e1', 'x', false, false)).rejects.toMatchObject({ code: 'ERR_BROWSER_DIALOG_PENDING' });
    await driver.answerDialog(false, undefined);
    await expect(driver.snapshot()).resolves.toMatchObject({ title: 'Sign up' });
  });

  it('revokes refs when the person takes over, until the next snapshot', async () => {
    const { page } = recordingPage();
    const driver = new PageDriver(page);
    await driver.snapshot();
    driver.revokeRefs();
    await expect(driver.type('e1', 'x', false, false)).rejects.toMatchObject({ code: 'ERR_BROWSER_STALE_REF' });
    await driver.snapshot();
    await expect(driver.type('e1', 'x', false, false)).resolves.toEqual({});
  });
});
