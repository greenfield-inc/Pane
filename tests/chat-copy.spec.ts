import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-140: a chat's text can be selected and copied, each message has a copy button,
// the conversation copies as Markdown with speakers, and code blocks copy alone.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');

async function open(page: Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/chat-tab-composer.html?width=720&labels=opus&conversation=1');
  await expect(page.getByText('Thanks, fix it please.')).toBeVisible();
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test('message text can be selected by dragging across several messages', async ({ page }) => {
  await open(page);
  const from = await page.getByText('Why does pnpm test fail?').boundingBox();
  const to = await page.getByText('Done: the import now points at').boundingBox();
  if (!from || !to) throw new Error('Messages are not on screen');
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('pnpm test fail?');
  expect(selected).toContain('Thanks, fix it please.');
  expect(selected).toContain('suite passes');
});

test('each message copies as Markdown, and its icon confirms', async ({ page }) => {
  await open(page);
  const message = page.getByRole('button', { name: 'Copy message' }).first();
  await page.getByText('Why does pnpm test fail?').hover();
  await expect(message).toBeVisible();
  await message.click();
  await expect(message).toHaveAttribute('data-state', 'copied');
  expect(await clipboard(page)).toBe('Why does pnpm test fail?');

  await page.getByRole('button', { name: 'Copy response' }).first().click();
  const response = await clipboard(page);
  expect(response).toContain('- Ran `pnpm test` (failed)');
  expect(response).toContain('```ts\nimport { a } from "./lib/a";\n```');
  expect(response).not.toContain('FAIL src/a.test.ts');
});

test('the whole conversation copies with speaker labels', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Copy conversation' }).click();
  const conversation = await clipboard(page);
  expect(conversation.startsWith('**You:**\n\nWhy does pnpm test fail?\n\n**Claude:**\n\n')).toBe(true);
  expect(conversation).toContain('**You:**\n\nThanks, fix it please.\n\n**Claude:**\n\nDone: the import now points at `./lib/a`, and the suite passes.');
});

test('a code block keeps its own copy button, for the code alone', async ({ page }) => {
  await open(page);
  await page.locator('.chat-code').hover();
  await page.getByRole('button', { name: 'Copy code' }).click();
  expect(await clipboard(page)).toBe('import { a } from "./lib/a";');
});
