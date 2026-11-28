import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// T-137: bullet lists in the chat input, an input that grows to about 40% of the chat before it
// scrolls, and a dock (approval, status row, input) that floats over the conversation.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const shots = process.env.PANE_VERIFY_DIR;

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('toolbar', { name: 'Chat status' })).toBeVisible();
}
const width = () => test.info().project.name === 'phone' ? 360 : 960;
const input = (page: Page) => page.locator('textarea.chat-input');
const sent = (page: Page) => page.evaluate(() => window.qaSent.map(({ text }) => text));

test('Enter continues a bullet list, Tab indents it, and Enter on an empty bullet ends it', async ({ page }) => {
  await open(page, `status=1&width=${width()}`);
  await input(page).click();
  await page.keyboard.type('Plan:');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('- first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.type('third');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('Plan:\n- first\n  - second\n- third\n- ');
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Thanks');
  expect(await sent(page)).toEqual([]);
  // Off the list, Enter sends, as plain markdown.
  await page.keyboard.press('Enter');
  await expect.poll(() => sent(page)).toEqual(['Plan:\n- first\n  - second\n- third\nThanks']);
});

test('undo takes back a continued bullet', async ({ page }) => {
  await open(page, `status=1&width=${width()}`);
  await input(page).click();
  await page.keyboard.type('- a');
  await page.keyboard.press('Enter');
  await expect(input(page)).toHaveValue('- a\n- ');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(input(page)).toHaveValue('- a');
});

test('the input grows to about 40% of the chat before it scrolls', async ({ page }) => {
  await open(page, `status=1&width=${width()}`);
  await input(page).fill(Array.from({ length: 60 }, (_, line) => `line ${line + 1}`).join('\n'));
  const chat = await page.locator('.chat-tab').evaluate(element => element.clientHeight);
  const height = await input(page).evaluate(element => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(Math.max(192, chat * 0.4) - 2);
  expect(height).toBeLessThan(Math.max(192, chat * 0.4) + 2);
  expect(await input(page).evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
});

test('the conversation shows through the dock\'s gaps and still scrolls its last line above it', async ({ page }) => {
  await open(page, `status=1&conversation=1&long=1&permission=1&width=${width()}`);
  const footer = page.locator('.chat-composer-footer');
  expect(await footer.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  // The conversation runs under the dock …
  const viewport = await page.locator('.chat-viewport').boundingBox();
  const dock = await footer.boundingBox();
  expect(viewport!.y + viewport!.height).toBeGreaterThan(dock!.y + dock!.height - 1);
  // … and scrolled to the end, its last turn sits fully above the dock.
  await page.locator('.chat-viewport').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const last = await page.locator('.chat-column .chat-turn').last().boundingBox();
  expect(last!.y + last!.height).toBeLessThanOrEqual(dock!.y + 0.5);
  // Scrolling up shows the jump-to-latest button, and it brings the end back.
  await page.locator('.chat-viewport').evaluate(element => { element.scrollTop = 0; });
  const latest = page.getByRole('button', { name: 'Scroll to latest message' });
  await expect(latest).toBeVisible();
  await latest.click();
  await expect.poll(() => page.locator('.chat-viewport').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
});

// T-138 (time on hover): each finished agent turn shows its finish time at the end of its action
// row when you hover it; the latest turn keeps its time in view; your own messages keep only the tooltip.
test('an agent turn shows when it finished on hover, and the latest keeps it in view', async ({ page }) => {
  await open(page, `status=1&conversation=1&times=1&width=${width()}`);
  const turns = page.locator('.chat-column .chat-turn');
  const first = turns.first().locator('.chat-turn-time');
  const latest = turns.last().locator('.chat-turn-time');
  await expect(first).toHaveText(/\d{1,2}:\d{2}/);
  await expect(first).toHaveAttribute('title', /\d{4}/);
  await expect(turns.first().locator('.chat-user-row .chat-turn-time')).toHaveCount(0);
  await expect(latest).toHaveCSS('opacity', '1');
  if (test.info().project.name === 'phone') return; // No hover on a touch screen: times stay visible, like Copy.
  await page.mouse.move(0, 0);
  await expect(first).toHaveCSS('opacity', '0');
  await turns.first().locator('.chat-response-actions').hover();
  await expect(first).toHaveCSS('opacity', '1');
  // It sits at the row's far end, apart from Copy.
  const copy = await turns.first().getByRole('button', { name: 'Copy response' }).boundingBox();
  const time = await first.boundingBox();
  const row = await turns.first().locator('.chat-response-actions').boundingBox();
  expect(time!.x).toBeGreaterThan(copy!.x + copy!.width);
  expect(time!.x + time!.width).toBeGreaterThan(row!.x + row!.width - 2);
  if (shots) await page.screenshot({ path: `${shots}/hover-time-${test.info().project.name}.png` });
});

if (shots) for (const theme of ['light', 'dark']) {
  test(`screenshots: bullets, a tall input and the floating dock (${theme})`, async ({ page }) => {
    const project = test.info().project.name;
    await open(page, `status=1&conversation=1&long=1&permission=1&width=${width()}&theme=${theme}`);
    await page.locator('.chat-viewport').evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 260; });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${shots}/dock-approval-${theme}-${project}.png` });
    await input(page).click();
    await page.keyboard.type('Notes for the next round:');
    await page.keyboard.press('Shift+Enter');
    for (const [index, line] of ['- check the approval card', 'and the status row', 'nested point', 'back out', 'last one'].entries()) {
      if (index) await page.keyboard.press('Enter');
      await page.keyboard.type(line);
      if (index === 2) await page.keyboard.press('Tab');
      if (index === 3) await page.keyboard.press('Shift+Tab');
    }
    await page.screenshot({ path: `${shots}/bullets-${theme}-${project}.png` });
    await input(page).fill(Array.from({ length: 40 }, (_, line) => `- line ${line + 1} of a long message`).join('\n'));
    await page.screenshot({ path: `${shots}/tall-input-${theme}-${project}.png` });
  });
}
