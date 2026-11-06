import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-139: files and photos dropped onto the chat, or pasted into its composer, attach as chips:
// images as image content, other files copied to the chat's machine with their path sent.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`/chat-tab-composer.html?width=640&labels=opus&${query}`);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
}

type Spec = { name: string; type: string; size?: number };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A DataTransfer in the page holding the given files (PNGs get real image bytes). */
async function transfer(page: Page, files: Spec[]) {
  return page.evaluateHandle(({ files, png }) => {
    const data = new DataTransfer();
    for (const file of files) {
      const bytes = file.type === 'image/png' && !file.size ? Uint8Array.from(atob(png), char => char.charCodeAt(0)) : new Uint8Array(file.size ?? 16);
      data.items.add(new File([bytes], file.name, { type: file.type }));
    }
    return data;
  }, { files, png: PNG });
}

async function drop(page: Page, files: Spec[]) {
  const data = await transfer(page, files);
  const target = page.getByRole('region', { name: 'Conversation messages' });
  await target.dispatchEvent('dragenter', { dataTransfer: data });
  await target.dispatchEvent('dragover', { dataTransfer: data });
  await expect(page.getByText('Drop to attach')).toBeVisible();
  await target.dispatchEvent('drop', { dataTransfer: data });
  await expect(page.getByText('Drop to attach')).toBeHidden();
}

const chips = (page: Page) => page.locator('.chat-composer .chat-attachment');

test('dropped photos and files attach as chips, and send as an image and a path', async ({ page }) => {
  await open(page, 'files=1');
  await drop(page, [{ name: 'screen.png', type: 'image/png' }, { name: 'notes.pdf', type: 'application/pdf' }]);
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).filter({ hasText: 'notes.pdf' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.qaCopied)).toEqual(['notes.pdf']);
  await page.getByRole('textbox', { name: 'Message Claude' }).fill('Look at these');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => page.evaluate(() => window.qaSent.length)).toBe(1);
  const sent = await page.evaluate(() => window.qaSent[0]);
  expect(sent.text).toBe('Look at these\n/repo/.pane/files/notes.pdf');
  expect(sent.images).toEqual([{ mimeType: 'image/png', data: PNG }]);
});

test('a chip can be removed before sending, and send waits while a file is still copying', async ({ page }) => {
  await open(page, 'files=1&holdCopies=1');
  await drop(page, [{ name: 'diagram.png', type: 'image/png' }, { name: 'log.txt', type: 'text/plain' }]);
  const copying = chips(page).filter({ hasText: 'log.txt' });
  await expect(copying).toContainText('Copying…');
  await page.getByRole('textbox', { name: 'Message Claude' }).fill('hi');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.evaluate(() => window.qaReleaseCopies?.());
  await expect(copying).not.toContainText('Copying…');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await chips(page).filter({ hasText: 'diagram.png' }).getByRole('button', { name: 'Remove attachment' }).click();
  await expect(chips(page)).toHaveCount(1);
});

test('a pasted image attaches as an image chip', async ({ page }) => {
  await open(page, 'files=1');
  const data = await transfer(page, [{ name: 'image.png', type: 'image/png' }]);
  // A real ClipboardEvent: Playwright's dispatchEvent does not carry clipboardData.
  await page.getByRole('textbox', { name: 'Message Claude' }).evaluate((input, clipboardData) => {
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, data);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute('data-kind', 'image');
  expect(await page.evaluate(() => window.qaCopied)).toEqual([]);
});

test('every refusal is shown and nothing is attached for it', async ({ page }) => {
  await open(page, 'files=1');
  await drop(page, [
    { name: 'movie.mov', type: 'video/quicktime', size: 10 * 1024 * 1024 + 1 },
    { name: 'fail.txt', type: 'text/plain' },
    { name: 'ok.png', type: 'image/png' },
  ]);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('movie.mov was not attached: it is larger than 10 MB');
  await expect(alert).toContainText("fail.txt was not attached: it could not be copied to the chat's machine (the host is offline).");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toContainText('ok.png');
  await alert.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('without a way to copy files, a chat attaches images and says why it refuses other files', async ({ page }) => {
  await open(page, '');
  await drop(page, [{ name: 'notes.pdf', type: 'application/pdf' }, { name: 'shot.png', type: 'image/png' }]);
  await expect(page.getByRole('alert')).toContainText('notes.pdf was not attached: this chat takes PNG, JPEG, WebP or GIF images here');
  await expect(chips(page)).toHaveCount(1);
});
