import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthTestTab } from './fixtures/browser-auth-renderer';

// Needs built main modules and a display (xvfb on Linux), unlike the browser-only suite.
test.skip(process.env.PANE_ELECTRON_E2E !== '1', 'Run with PANE_ELECTRON_E2E=1 after pnpm build:main');

interface Harness { app: ElectronApplication; page: Page; site: string; popupOrigin: string }

// The fixture keeps Electron's profile under paneDir, so nothing here touches a real Pane profile.
async function launch(paneDir: string, baseURL: string | undefined): Promise<Harness> {
  const app = await electron.launch({
    args: [path.resolve('tests/fixtures/browser-auth-main.cjs')],
    env: { ...process.env, PANE_DIR: paneDir },
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => console.error(error.stack));
  const fixture = path.resolve('tests/fixtures/browser-auth-renderer.tsx').replaceAll('\\', '/');
  await page.route('**/browser-auth-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><body style="margin:0"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/@fs/${fixture}');
    </script></body></html>`,
  }));
  await page.goto(`${baseURL}/browser-auth-test`);
  await page.waitForFunction(() => Boolean(window.authTest));
  const { site, popupOrigin } = await page.evaluate(() => window.electronAPI.invoke('auth-test:site'));
  return { app, page, site, popupOrigin };
}

const setTabs = (page: Page, tabs: AuthTestTab[]) => page.evaluate(value => window.authTest.setTabs(value), tabs);

function guest<T>(page: Page, tabId: string, script: string): Promise<T> {
  return page.locator(`[data-tab="${tabId}"] webview`).evaluate(
    // SAFETY: The locator selects Electron's webview tag in the Electron client fixture.
    (element, code) => (element as Electron.WebviewTag).executeJavaScript(code, true), script,
  );
}

const status = (page: Page, tabId: string) => guest<string>(page, tabId, 'document.getElementById("status")?.textContent ?? ""');

async function evidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  const dir = process.env.PANE_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

const partitionsOf = async (paneDir: string) => (await fs.readdir(path.join(paneDir, 'electron', 'Partitions'))).sort();

test('a login made in one project is shared with every project and Session, survives a restart, and reaches sign-in popups', async ({ baseURL }, testInfo) => {
  const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-browser-auth-'));
  let { app, page, site, popupOrigin } = await launch(paneDir, baseURL);
  try {
    // J1: sign in from a tab in project A; project B and an orchestration Session see it.
    await setTabs(page, [{ id: 'tab-a', sessionId: 'session-in-project-a', label: 'Project A', url: `${site}/login` }]);
    await expect.poll(() => status(page, 'tab-a')).toBe('Signed in');
    await setTabs(page, [
      { id: 'tab-a', sessionId: 'session-in-project-a', label: 'Project A', url: `${site}/login` },
      { id: 'tab-b', sessionId: 'session-in-project-b', label: 'Project B', url: site },
      { id: 'tab-orch', sessionId: '__orchestration_session_x__', label: 'Orchestration Session', url: site },
    ]);
    await expect.poll(() => status(page, 'tab-b')).toBe('Signed in');
    await expect.poll(() => status(page, 'tab-orch')).toBe('Signed in');
    expect(await guest(page, 'tab-orch', 'document.getElementById("detail").textContent')).toContain('cookie: yes, localStorage: yes');
    await evidence(page, testInfo, 'j1-shared-across-projects-and-sessions');

    // J3: a sized window.open on a second origin opens a real popup in the same store.
    await setTabs(page, [{ id: 'tab-opener', sessionId: 'session-in-project-a', label: 'Opener', url: `${site}/opener` }]);
    await expect.poll(() => status(page, 'tab-opener')).toBe('Waiting for popup');
    // A real click, since Chromium only lets a page open a popup from a user gesture.
    const button = await guest<{ x: number; y: number }>(page, 'tab-opener', `(() => {
      const rect = document.getElementById('sign-in').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    await page.locator('[data-tab="tab-opener"] webview').evaluate((element, point) => {
      // SAFETY: The locator selects Electron's webview tag in the Electron client fixture.
      const webview = element as Electron.WebviewTag;
      webview.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      webview.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }, button);
    await expect.poll(() => status(page, 'tab-opener')).toBe('Popup completed');
    expect(await page.evaluate(() => window.electronAPI.invoke('auth-test:window-count'))).toBe(2);
    await setTabs(page, [
      { id: 'tab-opener', sessionId: 'session-in-project-a', label: 'Opener', url: `${site}/opener` },
      { id: 'tab-popup-origin', sessionId: 'session-in-project-b', label: 'Popup origin', url: popupOrigin },
    ]);
    await expect.poll(() => guest(page, 'tab-popup-origin', 'document.cookie')).toContain('pane_popup=1');
    await evidence(page, testInfo, 'j3-popup-shares-store');
    await setTabs(page, [{ id: 'tab-popup-origin', sessionId: 'session-in-project-b', label: 'Popup origin', url: popupOrigin }]);
    await expect.poll(() => page.evaluate(() => window.electronAPI.invoke('auth-test:window-count'))).toBe(1);

    // J2: close every tab, quit, relaunch with the same profile.
    await setTabs(page, []);
    await app.close();
    ({ app, page, site, popupOrigin } = await launch(paneDir, baseURL));
    await setTabs(page, [{ id: 'tab-new-session', sessionId: '__orchestration_session_y__', label: 'New Session', url: site }]);
    await expect.poll(() => status(page, 'tab-new-session')).toBe('Signed in');
    expect((await partitionsOf(paneDir)).filter(name => name.startsWith('project-'))).toEqual([]);
    expect(await partitionsOf(paneDir)).toContain('pane-browser');
    await evidence(page, testInfo, 'j2-signed-in-after-restart');
  } finally {
    await app.close();
    await fs.rm(paneDir, { recursive: true, force: true });
  }
});

test('Clear browser data signs out of every site and removes the old per-project and per-Session stores', async ({ baseURL }, testInfo) => {
  const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-browser-clear-'));
  for (const name of ['project-3', 'project-__orchestration_session_x__', 'pane-docs']) {
    await fs.mkdir(path.join(paneDir, 'electron', 'Partitions', name), { recursive: true });
    await fs.writeFile(path.join(paneDir, 'electron', 'Partitions', name, 'Cookies'), 'old store');
  }
  let { app, page, site } = await launch(paneDir, baseURL);
  try {
    await setTabs(page, [
      { id: 'tab-a', sessionId: 'session-in-project-a', label: 'Project A', url: `${site}/login` },
      { id: 'tab-basic', sessionId: 'session-in-project-b', label: 'Password site', url: `${site}/basic-login` },
    ]);
    await expect.poll(() => status(page, 'tab-a')).toBe('Signed in');
    // HTTP Basic sign-ins live in the auth cache, which clearing cookies and storage doesn't touch.
    await expect.poll(() => status(page, 'tab-basic')).toBe('Password signed in');

    // Cancel leaves everything as it was.
    await page.getByRole('button', { name: 'Clear browser data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clear browser data?' });
    await expect(dialog).toContainText("This signs you out of every site in Pane's browser, including GitHub and Grain");
    await evidence(page, testInfo, 'j5-confirm-dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await partitionsOf(paneDir)).toEqual(['pane-browser', 'pane-docs', 'project-3', 'project-__orchestration_session_x__']);
    await page.waitForTimeout(500);
    expect(await status(page, 'tab-a')).toBe('Signed in');

    // Confirm reloads the open tab signed out and reports success.
    await page.getByRole('button', { name: 'Clear browser data' }).click();
    await page.getByRole('dialog', { name: 'Clear browser data?' }).getByRole('button', { name: 'Clear browser data' }).click();
    await expect(page.getByText("Browser data cleared. You're signed out of every site in Pane's browser.")).toBeVisible();
    await expect.poll(() => status(page, 'tab-a')).toBe('Signed out');
    expect(await guest(page, 'tab-a', 'document.getElementById("detail").textContent')).toContain('cookie: no, localStorage: no');
    await expect.poll(() => status(page, 'tab-basic')).toBe('Password signed out');
    await evidence(page, testInfo, 'j5-cleared-and-signed-out');

    // After a restart the tab is still signed out and only the stores Pane uses remain.
    await setTabs(page, []);
    await app.close();
    ({ app, page, site } = await launch(paneDir, baseURL));
    await setTabs(page, [{ id: 'tab-b', sessionId: 'session-in-project-b', label: 'Project B', url: site }]);
    await expect.poll(() => status(page, 'tab-b')).toBe('Signed out');
    expect(await partitionsOf(paneDir)).toEqual(['pane-browser', 'pane-docs']);
    await expect(fs.readFile(path.join(paneDir, 'electron', 'Partitions', 'pane-docs', 'Cookies'), 'utf8')).resolves.toBe('old store');
    await evidence(page, testInfo, 'j5-signed-out-after-restart');
  } finally {
    await app.close();
    await fs.rm(paneDir, { recursive: true, force: true });
  }
});
