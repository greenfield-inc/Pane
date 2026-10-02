import { _electron as electron, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Needs built main modules and a display (xvfb on Linux), unlike the browser-only suite.
test.skip(process.env.PANE_ELECTRON_E2E !== '1', 'Run with PANE_ELECTRON_E2E=1 after pnpm build:main');

test('remote browser loads host HTML, assets and linked pages through the remote channel', async ({ baseURL }, testInfo) => {
  const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-remote-browser-'));
  const app = await electron.launch({
    args: [path.resolve('tests/fixtures/remote-browser-main.cjs')],
    env: { ...process.env, PANE_DIR: paneDir },
  });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => console.error(error.stack));
    const fixture = path.resolve('tests/fixtures/remote-browser-renderer.tsx').replaceAll('\\', '/');
    await page.route('**/remote-preview-test', route => route.fulfill({
      contentType: 'text/html',
      body: `<html><body style="margin:0"><div id="root" style="height:100vh"></div><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        await import('/@fs/${fixture}');
      </script></body></html>`,
    }));
    await page.goto(`${baseURL}/remote-preview-test`);
    await expect(page.locator('webview')).toBeVisible();
    const guest = async <T>(script: string): Promise<T> => page.locator('webview').evaluate(
      // SAFETY: This locator selects Electron's webview tag in the Electron client fixture.
      (element, code) => (element as Electron.WebviewTag).executeJavaScript(code, true), script,
    );
    await expect.poll(() => guest('document.body.innerText')).toContain('Rendered from the host');
    expect(await guest('getComputedStyle(document.body).backgroundColor')).toBe('rgb(238, 245, 240)');
    await expect.poll(() => guest('document.querySelector("img").naturalWidth')).toBe(100);
    await expect(page.locator('input')).toHaveValue(/\/index\.html$/);
    await page.screenshot({ path: testInfo.outputPath('remote-client-rendered.png') });
    await guest('document.querySelector("a").click()');
    await expect.poll(() => guest('document.body.innerText')).toContain('Sibling navigation works');
    await guest('document.querySelector("a").click()');
    await expect.poll(() => guest('document.body.innerText')).toContain('Rendered from the host');
    const externalUrl: string = await page.evaluate(() => window.electronAPI.invoke('preview-test:host-url'));
    await guest(`location.href = ${JSON.stringify(externalUrl)}`);
    await expect.poll(() => guest('location.href')).toBe(externalUrl);
    // Wait past the URL-persistence debounce to catch an external link replacing
    // the host's entry grant before returning to the file.
    await page.waitForTimeout(2200);
    await page.getByTitle('Back', { exact: true }).click();
    await expect.poll(() => guest('document.body.innerText')).toContain('Rendered from the host');
    const entryUrl = await page.locator('input').inputValue();
    expect(entryUrl).toMatch(/\/index\.html$/);
    await guest('document.querySelector("a").click()');
    await expect.poll(() => guest('document.body.innerText')).toContain('Sibling navigation works');
    await page.locator('input').fill(entryUrl);
    await page.locator('input').press('Enter');
    await expect.poll(() => guest('document.body.innerText')).toContain('Rendered from the host');
    const evidence = await page.evaluate(() => window.electronAPI.invoke('preview-test:requests'));
    expect(evidence.requests).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/index\.html$/), expect.stringMatching(/\/theme\.css$/),
      expect.stringMatching(/\/mark\.svg$/), expect.stringMatching(/\/nested\/next\.html$/),
    ]));
    expect(evidence.persisted).toEqual([]);
    const attackerUrl = 'file:///private/nonexistent.html';
    await expect(page.evaluate(url => window.electronAPI.invoke('preview-test:remote-command', 'panels:update', [
      'remote-preview', { state: { customState: { currentUrl: url } } },
    ]), attackerUrl)).rejects.toThrow('on the host');
    await expect(page.evaluate(url => window.electronAPI.invoke('preview-test:remote-command', 'panels:create', [{
      sessionId: 'test-pane', type: 'browser', initialState: { currentUrl: url },
    }]), attackerUrl)).rejects.toThrow('on the host');
    await guest('location.href = new URL("../private.txt", location.href).href');
    await expect.poll(() => guest('document.body.innerText')).toContain('Unable to read this file from the host');
    await page.evaluate(() => window.electronAPI.invoke('preview-test:disconnect'));
    await page.getByTitle('Refresh', { exact: true }).click();
    await expect.poll(() => guest('document.body.innerText')).toContain('The connected host has changed');
    // Local file navigation must retain the same guest and Back history after
    // its debounced URL write is reflected back into panel props.
    // Keep identical panel/session IDs mounted while changing runtimes.
    await page.evaluate(() => window.electronAPI.invoke('preview-test:resync', false));
    await expect(page.locator('webview')).toHaveCount(0);
    await expect(page.locator('webview')).toBeVisible();
    await expect.poll(() => guest('document.body.innerText')).toContain('Rendered from local disk');
    const localEntryUrl = await page.locator('input').inputValue();
    expect(localEntryUrl).not.toBe(entryUrl);
    const guestId = await page.locator('webview').evaluate(element => {
      // SAFETY: The locator selects the real Electron webview.
      return (element as Electron.WebviewTag).getWebContentsId();
    });
    await guest('document.querySelector("a").click()');
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.invoke('preview-test:requests'))).persisted.length).toBeGreaterThan(0);
    expect(await page.locator('webview').evaluate(element => {
      // SAFETY: The locator selects the real Electron webview.
      return (element as Electron.WebviewTag).getWebContentsId();
    })).toBe(guestId);
    await page.getByTitle('Back', { exact: true }).click();
    await expect.poll(() => guest('document.body.innerText')).toContain('Rendered from local disk');
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.invoke('preview-test:requests'))).persisted.at(-1)?.[1].state.customState.currentUrl).toBe(localEntryUrl);
    const requestsBeforeSwitch = (await page.evaluate(() => window.electronAPI.invoke('preview-test:requests'))).requests.length;
    await page.evaluate(() => window.electronAPI.invoke('preview-test:resync', true));
    await expect(page.locator('webview')).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.invoke('preview-test:requests'))).requests.length).toBeGreaterThan(requestsBeforeSwitch);
    await expect.poll(() => guest('document.body.innerText')).toContain('Rendered from the host');
    // The host can adopt the same HTTP page the client already followed. This
    // is an authoritative session transition, not an echo of client browsing.
    await guest(`location.href = ${JSON.stringify(externalUrl)}`);
    await expect.poll(() => guest('location.href')).toBe(externalUrl);
    await page.evaluate(() => window.electronAPI.invoke('preview-test:host-http'));
    await expect.poll(() => guest('location.href')).toBe(externalUrl);
    await expect.poll(() => guest('document.cookie')).toContain('project-session=available');
    const nextHttpUrl = `${externalUrl}?next=1`;
    await page.locator('input').fill(nextHttpUrl);
    await page.locator('input').press('Enter');
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.invoke('preview-test:requests'))).persisted.at(-1)?.[1].state.customState.currentUrl).toBe(nextHttpUrl);
  } finally {
    await app.close();
    await fs.rm(paneDir, { recursive: true, force: true });
  }
});
