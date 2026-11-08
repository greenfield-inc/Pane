import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-211: while a turn runs, Enter queues and Cmd/Ctrl+Enter sends now; queued messages can be
// edited, removed or sent now; /clear starts a fresh conversation, asking first mid-turn.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const shots = process.env.PANE_VERIFY_DIR;

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('textbox', { name: 'Message Claude' })).toBeVisible();
}
const calls = (page: Page) => page.evaluate(() => window.qaCalls);
const sent = (page: Page) => page.evaluate(() => window.qaSent.map(({ text, now }) => ({ text, now })));

test('Enter queues and Cmd/Ctrl+Enter sends now while a turn runs', async ({ page }) => {
  await open(page, 'working=1&width=640');
  const input = page.getByRole('textbox', { name: 'Message Claude' });
  await input.fill('after this turn');
  await input.press('Enter');
  await expect.poll(() => sent(page)).toEqual([{ text: 'after this turn', now: undefined }]);
  await input.fill('right now');
  await input.press('ControlOrMeta+Enter');
  await expect.poll(() => sent(page)).toEqual([{ text: 'after this turn', now: undefined }, { text: 'right now', now: true }]);
});

test('Cmd/Ctrl+Enter with no turn running is a plain send', async ({ page }) => {
  await open(page, 'width=640');
  const input = page.getByRole('textbox', { name: 'Message Claude' });
  await input.fill('hello');
  await input.press('ControlOrMeta+Enter');
  await expect.poll(() => sent(page)).toEqual([{ text: 'hello', now: undefined }]);
});

test('queued messages show in order and can be sent now, edited and removed', async ({ page }) => {
  await open(page, 'working=1&queue=2&width=640');
  const rows = page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Sends next');
  await expect(rows.nth(1)).toContainText('2 in queue');
  await rows.nth(1).getByRole('button', { name: 'Send now' }).click();
  await rows.nth(0).getByRole('button', { name: 'Edit queued message' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit queued message' });
  await editor.fill('Run the linter and the tests');
  if (shots) await page.screenshot({ path: `${shots}/queue-editing-${test.info().project.name}.png` });
  await editor.press('Enter');
  await rows.nth(1).getByRole('button', { name: 'Remove from queue' }).click();
  await expect.poll(() => calls(page)).toEqual(['sendNow:q2', 'edit:q1:Run the linter and the tests', 'unqueue:q2']);
});

test('/clear asks first while a turn runs, and never reaches the agent', async ({ page }) => {
  await open(page, 'working=1&width=640');
  const input = page.getByRole('textbox', { name: 'Message Claude' });
  await input.fill('/cl');
  await expect(page.getByText('Start a fresh conversation in this tab')).toBeVisible();
  await input.fill('/clear');
  await input.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: 'Clear the conversation?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(() => calls(page)).toEqual(['clear']);
  expect(await sent(page)).toEqual([]);
});

test('a cleared conversation starts with its divider', async ({ page }) => {
  await open(page, 'cleared=1&width=640');
  await expect(page.getByRole('separator').filter({ hasText: /^Cleared · / })).toBeVisible();
});

if (shots) for (const theme of ['light', 'dark']) {
  test(`screenshots: queue, Send now and the /clear divider (${theme})`, async ({ page }) => {
    await open(page, `working=1&queue=2&cleared=1&width=${test.info().project.name === 'phone' ? 360 : 640}&theme=${theme}`);
    await page.screenshot({ path: `${shots}/queue-${theme}-${test.info().project.name}.png` });
    const input = page.getByRole('textbox', { name: 'Message Claude' });
    await input.fill('/clear');
    await input.press('Enter');
    await page.screenshot({ path: `${shots}/clear-confirm-${theme}-${test.info().project.name}.png` });
  });
}
