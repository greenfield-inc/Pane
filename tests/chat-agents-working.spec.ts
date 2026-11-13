import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-276: "N working" above the chat box counts the Session's agents actively working, nothing else;
// clicking it lists each one with its tab, and a row opens that tab.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const shots = process.env.PANE_VERIFY_DIR;

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('toolbar', { name: 'Chat status' })).toBeVisible();
}
const width = () => test.info().project.name === 'phone' ? 360 : 640;
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Chat status' });

test('"N working" counts only the agents working, and each row opens its tab', async ({ page }) => {
  await open(page, `agents=3&status=1&width=${width()}`);
  const item = bar(page).getByRole('button', { name: '3 working' });
  await expect(item).toBeVisible();
  await item.click();
  const list = page.getByRole('dialog', { name: 'Agents working' });
  await expect(list.getByRole('button')).toHaveCount(3);
  await expect(list).not.toContainText('approvals-global');
  await expect(list).not.toContainText('release-notes');
  await list.getByRole('button', { name: /switch-to-chat/ }).click();
  await expect.poll(() => page.evaluate(() => window.qaCalls)).toEqual(['open:p2:t2']);
});

test('the item is hidden when nothing is working, and in a chat with no Session workers', async ({ page }) => {
  await open(page, `agents=0&status=1&width=${width()}`);
  await expect(bar(page).getByRole('button', { name: /working$/ })).toHaveCount(0);
  await open(page, `status=1&width=${width()}`);
  await expect(bar(page).getByRole('button', { name: /working$/ })).toHaveCount(0);
});

if (shots) for (const theme of ['light', 'dark']) {
  test(`screenshots: "N working" and its list (${theme})`, async ({ page }) => {
    const project = test.info().project.name;
    const shotWidth = project === 'phone' ? 360 : 960;
    await open(page, `agents=3&status=1&conversation=1&width=${shotWidth}&theme=${theme}`);
    await page.screenshot({ path: `${shots}/working-${theme}-${project}.png` });
    await bar(page).getByRole('button', { name: '3 working' }).click();
    await page.screenshot({ path: `${shots}/working-list-${theme}-${project}.png` });
  });
}
