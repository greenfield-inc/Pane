import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-222, D-253 to D-255: one footer line above the composer with model and effort, context left,
// permission mode, the Pane's PR, background tasks and queued messages; each opens what it names,
// and "…" picks which show, remembered on this device.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const shots = process.env.PANE_VERIFY_DIR;

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('toolbar', { name: 'Chat status' })).toBeVisible();
}
const calls = (page: Page) => page.evaluate(() => window.qaCalls);
const width = () => test.info().project.name === 'phone' ? 360 : 640;
// Screenshots use a wide desktop column, so the send-now hint shows.
const shotWidth = () => test.info().project.name === 'phone' ? 360 : 960;
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Chat status' });

test('the bar shows every default item, in order', async ({ page }) => {
  await open(page, `status=1&working=1&queue=2&mode=acceptEdits&width=${width()}`);
  // What a sighted reader sees: screen-reader-only words left out.
  const text = await bar(page).locator('.chat-status-items').evaluate(items => {
    const copy = items.cloneNode(true);
    if (!(copy instanceof HTMLElement)) return '';
    copy.querySelectorAll('.sr-only').forEach(hidden => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ');
  });
  const phone = test.info().project.name === 'phone';
  // The phone's line is compact: the percentage alone, the PR's number alone.
  const expected = phone ? ['Opus 5.5', 'Medium', '41%', 'Accept edits', '#1272', '2 tasks', '2 queued'] : ['Opus 5.5 · Medium', 'Ctx 41%', 'Accept edits', '#1272 · Open', '2 tasks', '2 queued'];
  let at = -1;
  for (const part of expected) {
    const next = text.indexOf(part, at + 1);
    expect(next, `${part} follows`).toBeGreaterThan(at);
    at = next;
  }
});

test('context left opens its detail and turns amber near the limit; with no usage it is absent', async ({ page }) => {
  await open(page, `status=1&width=${width()}`);
  const context = bar(page).getByRole('button', { name: /41% left/ });
  await expect(context).not.toHaveAttribute('data-tone', 'warning');
  await context.click();
  const detail = page.getByRole('dialog', { name: 'Context left' });
  await expect(detail).toContainText('41% of context left');
  await expect(detail).toContainText('118k of 200k tokens used');
  await detail.getByRole('button', { name: 'Clear conversation' }).click();
  await expect.poll(() => calls(page)).toEqual(['clear']);

  await open(page, `status=1&ctx=low&width=${width()}`);
  await expect(bar(page).getByRole('button', { name: /14% left/ })).toHaveAttribute('data-tone', 'warning');

  await open(page, `width=${width()}`);
  await expect(bar(page).getByRole('button', { name: /% left/ })).toHaveCount(0);
});

test('tasks list what runs in the background, with Stop where the adapter allows it', async ({ page }) => {
  await open(page, `status=1&width=${width()}`);
  await bar(page).getByRole('button', { name: '2 tasks' }).click();
  const list = page.getByRole('dialog', { name: 'Background tasks' });
  await expect(list).toContainText('pnpm --filter frontend test --watch');
  await expect(list).toContainText('Explore: find the queue code');
  await expect(list.getByRole('button', { name: 'Stop' })).toHaveCount(1);
  await list.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => calls(page)).toEqual(['stopTask:t1']);
});

test('the PR opens on GitHub, the queue count goes to the queue, and the mode menu changes the mode', async ({ page }) => {
  await open(page, `status=1&working=1&queue=2&mode=acceptEdits&width=${width()}`);
  await expect(bar(page).getByRole('link', { name: /#1272/ })).toHaveAttribute('href', 'https://github.com/greenfield-inc/Pane/pull/1272');
  await bar(page).getByRole('button', { name: '2 queued' }).click();
  await expect(page.getByRole('list', { name: 'Queued messages' }).getByRole('button').first()).toBeFocused();
  // Settings are locked while a turn runs; between turns the mode item changes the mode.
  await expect(bar(page).getByRole('button', { name: /Mode: Accept edits/ })).toBeDisabled();
  await open(page, `status=1&mode=acceptEdits&width=${width()}`);
  await bar(page).getByRole('button', { name: /Mode: Accept edits/ }).click();
  await page.getByRole('menuitemradio', { name: 'Plan mode' }).click();
  await expect.poll(() => calls(page)).toEqual(['configure:mode:plan']);
});

test('"…" picks the items, remembered on this device, and Reset to default brings them back', async ({ page }) => {
  await open(page, `status=1&width=${width()}`);
  await bar(page).getByRole('button', { name: 'Choose what the status bar shows' }).click();
  const menu = page.getByRole('dialog', { name: 'Status bar items' });
  await menu.getByRole('checkbox', { name: 'Background tasks' }).uncheck();
  await expect(bar(page).getByRole('button', { name: '2 tasks' })).toHaveCount(0);
  await page.reload();
  await expect(bar(page)).toBeVisible();
  await expect(bar(page).getByRole('button', { name: '2 tasks' })).toHaveCount(0);
  await bar(page).getByRole('button', { name: 'Choose what the status bar shows' }).click();
  await page.getByRole('dialog', { name: 'Status bar items' }).getByRole('button', { name: 'Reset to default' }).click();
  await expect(bar(page).getByRole('button', { name: '2 tasks' })).toBeVisible();
});

if (shots) for (const theme of ['light', 'dark']) {
  test(`screenshots: the status bar and its menus (${theme})`, async ({ page }) => {
    const project = test.info().project.name;
    await open(page, `status=1&working=1&queue=2&mode=acceptEdits&conversation=1&width=${shotWidth()}&theme=${theme}`);
    await page.screenshot({ path: `${shots}/bar-${theme}-${project}.png` });
    await bar(page).getByRole('button', { name: 'Choose what the status bar shows' }).click();
    await page.screenshot({ path: `${shots}/customize-${theme}-${project}.png` });
    await page.keyboard.press('Escape');
    await bar(page).getByRole('button', { name: /41% left/ }).click();
    await page.screenshot({ path: `${shots}/context-${theme}-${project}.png` });
    await page.keyboard.press('Escape');
    await bar(page).getByRole('button', { name: '2 tasks' }).click();
    await page.screenshot({ path: `${shots}/tasks-${theme}-${project}.png` });
    await open(page, `status=1&ctx=low&width=${shotWidth()}&theme=${theme}`);
    await page.screenshot({ path: `${shots}/context-low-${theme}-${project}.png` });
  });
}
