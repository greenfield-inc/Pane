import { expect, test, type Page } from '@playwright/test';
import { bundleFixture } from './fixtures/bundle';
import type { ListeningPortsSnapshot } from '../shared/types/listeningPorts';

const snapshot = (...ports: number[]): ListeningPortsSnapshot => ({
  host: 'devbox',
  ports: ports.map(port => ({ port, pid: port, process: 'node', group: 'other', kind: 'web' })),
});

async function openBrowserPanel(page: Page, url = ''): Promise<void> {
  const fixture = await bundleFixture('browser-ports');
  // A real origin: the panel's stores read localStorage, which about:blank denies.
  await page.route('https://pane.test/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root" style="height: 100vh"></div>' }));
  await page.goto(`https://pane.test/#${new URLSearchParams({ url })}`);
  await page.addScriptTag({ content: fixture });
}

/** Sends a guest event to the tab's `<webview>` once the panel listens for it, the guest now reporting `url`. */
async function guestEvent(page: Page, type: string, url: string, { canGoBack, fields = {} }: { canGoBack?: boolean; fields?: { isMainFrame: boolean; errorCode: number; errorDescription: string } } = {}): Promise<void> {
  const webview = page.locator('webview');
  await expect.poll(() => webview.evaluate((element, event) => window.portsTest.listensTo(element, event), type)).toBe(true);
  await webview.evaluate((element, event) => {
    Object.assign(element, { getURL: () => event.url });
    if (event.canGoBack !== undefined) Object.assign(element, { canGoBack: () => event.canGoBack, canGoForward: () => false });
    element.dispatchEvent(Object.assign(new Event(event.type), event.fields));
  }, { type, url, canGoBack, fields });
}

const answerPortsList = (page: Page, ports: ListeningPortsSnapshot) => page.evaluate(value => window.portsTest.answerPortsList(value), ports);
const answerConnectionState = (page: Page, mode: 'local' | 'remote') => page.evaluate(value => window.portsTest.answerConnectionState(value), mode);
const emitPorts = (page: Page, ports: ListeningPortsSnapshot) => page.evaluate(value => window.portsTest.emitPorts(value), ports);
const loadConfig = (page: Page, mode: 'local' | 'remote') => page.evaluate(value => window.portsTest.loadConfig(value), mode);

test('ports open only once this computer is known to be the host', async ({ page }) => {
  await openBrowserPanel(page);
  await answerPortsList(page, snapshot(5173));

  await expect(page.getByText('5173')).toBeVisible();
  await expect(page.getByTitle('Open localhost:5173')).toHaveCount(0);

  await answerConnectionState(page, 'local');
  await expect(page.getByTitle('Open localhost:5173')).toBeVisible();
});

test('ports stay closed on a remote desktop', async ({ page }) => {
  await openBrowserPanel(page);
  await answerPortsList(page, snapshot(5173));
  await answerConnectionState(page, 'remote');

  await expect(page.getByText("These ports are on devbox, so this computer can't open them.")).toBeVisible();
  await expect(page.getByTitle('Open localhost:5173')).toHaveCount(0);
});

test('a late list reply does not replace a newer port change', async ({ page }) => {
  await openBrowserPanel(page);
  await answerConnectionState(page, 'local');
  await emitPorts(page, snapshot(5174));
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();

  await answerPortsList(page, snapshot(5173));
  // Give the late reply time to render if it were going to.
  await page.waitForTimeout(200);
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();
  await expect(page.getByText('5173')).toHaveCount(0);
});

test('opening the Ports menu lists a port that started after the tab opened', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173');
  await answerConnectionState(page, 'local');
  await answerPortsList(page, snapshot(5173));
  const trigger = page.getByRole('button', { name: /Ports/ });
  await expect(trigger).toContainText('1');

  await trigger.click();
  await answerPortsList(page, snapshot(5173, 5175));
  await expect(page.getByTitle('Open localhost:5175')).toBeVisible();
});

test('an open browser tab counts a port that started elsewhere within a minute', async ({ page }) => {
  await page.clock.install();
  await openBrowserPanel(page, 'http://localhost:5173');
  await answerConnectionState(page, 'local');
  await answerPortsList(page, snapshot(5173));
  const trigger = page.getByRole('button', { name: /Ports/ });
  await expect(trigger).toContainText('1');

  await answerPortsList(page, snapshot(5173, 5175));
  await page.clock.fastForward(60_000);
  await expect(trigger).toContainText('2');
});

test('an open browser tab reads ports again when the window comes back on screen', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173');
  await answerConnectionState(page, 'local');
  await answerPortsList(page, snapshot(5173));
  const trigger = page.getByRole('button', { name: /Ports/ });
  await expect(trigger).toContainText('1');

  await answerPortsList(page, snapshot(5173, 5175));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(trigger).toContainText('2');
});

test('the Ports menu works from the keyboard', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173');
  await answerConnectionState(page, 'local');
  await answerPortsList(page, snapshot(5173, 5174));
  const trigger = page.getByRole('button', { name: /Ports/ });

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTitle('Open localhost:5173')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTitle('Open localhost:5174')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTitle('Open localhost:5174')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test.describe('a remote desktop loading a host page', () => {
  const tunnelled = (localPort: number): ListeningPortsSnapshot => ({
    host: 'devbox',
    ports: [{ port: 5173, pid: 5173, process: 'node', group: 'other', kind: 'web', localPort }],
  });
  const page5173 = 'http://localhost:5173/app';

  test('waits for the host\'s ports, then loads the tunnelled port marked with the host', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await expect(page.getByText("Connecting to the host's ports…")).toBeVisible();
    await expect(page.locator('webview')).toHaveCount(0);

    await answerPortsList(page, tunnelled(5174));
    await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:5174/app');
    await expect(page.getByText('on devbox')).toBeVisible();
  });

  test('never loads this computer\'s own port for a host port without a tunnel', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await answerPortsList(page, snapshot(5173));

    await expect(page.getByText("Port 5173 on devbox isn't reachable from this computer.")).toBeVisible();
    await expect(page.locator('webview')).toHaveCount(0);
  });

  test('unloads the page while the host stops listening, and loads it again when the port returns', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await answerPortsList(page, tunnelled(5174));
    await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:5174/app');

    await emitPorts(page, { host: 'devbox', ports: [] });
    await expect(page.getByText("The host isn't listing it right now.", { exact: false })).toBeVisible();
    await expect(page.locator('webview')).toHaveCount(0);

    await emitPorts(page, tunnelled(5175));
    await expect(page.locator('webview')).toHaveAttribute('src', 'http://localhost:5175/app');
  });

  test('loads the URL as it is from a host too old to list ports', async ({ page }) => {
    await openBrowserPanel(page, page5173);
    await loadConfig(page, 'remote');
    await answerPortsList(page, { host: 'old host', ports: [], unsupportedHost: true });

    await expect(page.locator('webview')).toHaveAttribute('src', page5173);
    await expect(page.getByText('on old host')).toHaveCount(0);
  });
});

test('a page that loads after its skeleton shows still follows the page\'s own navigation', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173/login');
  await expect(page.locator('[data-skeleton="visible"]')).toBeAttached();
  await loadConfig(page, 'local');

  await guestEvent(page, 'did-navigate', 'http://localhost:5173/settings', { canGoBack: true });
  await expect(page.getByPlaceholder('Enter a URL (e.g. localhost:3000)')).toHaveValue('http://localhost:5173/settings');
  await expect(page.getByTitle('Back')).toBeEnabled();
});

test('Open in your browser hands the tab\'s address to the OS, and says why when it cannot', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173/login');
  await loadConfig(page, 'local');
  const open = page.getByTitle('Open in your browser');

  await open.click();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedExternally)).toEqual(['http://localhost:5173/login']);

  // A link clicked inside the page moves the tab without a new address being typed.
  await guestEvent(page, 'did-navigate', 'http://localhost:5173/settings', { canGoBack: true });
  await open.click();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedExternally.at(-1))).toBe('http://localhost:5173/settings');

  // A page that fails to load never sends did-navigate, but the tab shows its address.
  await guestEvent(page, 'did-fail-load', 'http://localhost:5174/', { fields: { isMainFrame: true, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED' } });
  await open.click();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedExternally.at(-1))).toBe('http://localhost:5174/');

  await page.evaluate(() => { window.portsTest.openExternalError = 'That port on the host is not reachable from this computer right now.'; });
  await open.click();
  await expect(page.getByText('That port on the host is not reachable from this computer right now.')).toBeVisible();
});

test('Open in your browser opens a local .html page, and says why when it cannot', async ({ page }) => {
  await openBrowserPanel(page, 'file:///Users/me/status.html');
  await loadConfig(page, 'local');

  await page.getByTitle('Open in your browser').click();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedLocally)).toEqual(['file:///Users/me/status.html browser-1']);

  await guestEvent(page, 'did-navigate', 'file:///Users/me/notes.txt', { canGoBack: true });
  await page.getByTitle("Can't open in your browser: Only .html and .htm files open in your browser").click();
  await expect(page.getByText("Pane can't open this page in your browser: Only .html and .htm files open in your browser.")).toBeVisible();

  await guestEvent(page, 'did-navigate', 'file://server/share/page.html');
  await page.getByTitle("Can't open in your browser: This file is on server, not this computer").click();
  await expect(page.getByText("Pane can't open this page in your browser: This file is on server, not this computer.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedLocally)).toHaveLength(1);
});

test('on a remote desktop, Open in your browser opens the host\'s .html page through its tab', async ({ page }) => {
  await openBrowserPanel(page, 'file:///Users/me/session/index.html');
  await loadConfig(page, 'remote');
  await answerPortsList(page, snapshot());

  await page.evaluate(() => window.portsTest.holdLocalOpens());
  await page.getByTitle('Open in your browser').click();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedLocally)).toEqual(['file:///Users/me/session/index.html browser-1']);

  // Copying the page from the host takes a while: a second click waits for the first instead of opening another copy.
  await page.getByTitle('Opening in your browser…').click();
  await page.evaluate(() => window.portsTest.finishLocalOpen?.());
  await expect(page.getByTitle('Open in your browser')).toBeVisible();
  expect(await page.evaluate(() => window.portsTest.openedLocally)).toHaveLength(1);
});

test('on a remote desktop, Open in your browser waits for a forwarded port', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173/');
  await loadConfig(page, 'remote');
  await answerPortsList(page, snapshot(5173));
  await page.getByTitle("Can't open in your browser: Port 5173 on devbox isn't forwarded to this computer").click();
  await expect(page.getByText("Pane can't open this page in your browser: Port 5173 on devbox isn't forwarded to this computer.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedExternally)).toEqual([]);

  await emitPorts(page, { host: 'devbox', ports: [{ port: 5173, localPort: 5173, pid: 1, process: 'node', group: 'other', kind: 'web' }] });
  await page.getByTitle('Open in your browser').click();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedExternally)).toEqual(['http://localhost:5173/']);

  // The tab moves to a port the host doesn't forward: the button names that port, not the page before it.
  await guestEvent(page, 'did-navigate', 'http://localhost:5173/');
  await page.getByPlaceholder('Enter a URL (e.g. localhost:3000)').fill('localhost:5174');
  await page.keyboard.press('Enter');
  await page.getByTitle("Can't open in your browser: Port 5174 on devbox isn't forwarded to this computer").click();
  await expect(page.getByText("Pane can't open this page in your browser: Port 5174 on devbox isn't forwarded to this computer.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedExternally)).toEqual(['http://localhost:5173/']);
});

test('a sign-in Google refuses shows one line for its page, which opens that page in your browser', async ({ page }) => {
  await openBrowserPanel(page, 'https://www.reddit.com/login/');
  await loadConfig(page, 'local');
  await guestEvent(page, 'did-navigate', 'https://www.reddit.com/login/');
  const refuse = () => page.evaluate(() => window.dispatchEvent(new CustomEvent('browser-panel:notice', {
    detail: { panelId: 'browser-1', notice: { kind: 'sign-in', site: 'Google', url: 'https://www.reddit.com/login/' } },
  })));
  const line = page.getByText("Google won't sign in here.");

  await refuse();
  await refuse();
  await refuse();
  await expect(line).toHaveCount(1);

  await page.getByRole('button', { name: 'Open this page in your browser' }).click();
  await expect.poll(() => page.evaluate(() => window.portsTest.openedExternally)).toEqual(['https://www.reddit.com/login/']);
  await expect(line).toHaveCount(0);

  // Google refusing again on the same page stays quiet; the page loading again resets it.
  await refuse();
  await expect(line).toHaveCount(0);
  await guestEvent(page, 'did-navigate', 'https://www.reddit.com/login/');
  await refuse();
  await expect(line).toHaveCount(1);

  // The line belongs to its page: moving on drops it.
  await guestEvent(page, 'did-navigate', 'https://accounts.google.com/v3/signin/identifier');
  await expect(line).toHaveCount(0);
});
