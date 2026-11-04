import { expect, test } from '@playwright/test';
import { bundleFixture } from './fixtures/bundle';
import path from 'node:path';

const html = '<!doctype html><meta http-equiv="refresh" content="0;url=https://outside.test/refresh"><style>@import "https://outside.test/style";</style><script>window.previewScriptRan = true</script><img src="https://outside.test/image"><a href="https://outside.test/page">External link</a>';

test('HTML opens as editable source that saves, renders only in a browser tab, and never runs in Pane', async ({ page }) => {
  const fixture = await bundleFixture('html-editable-source', { '@monaco-editor/react': path.resolve('tests/fixtures/editor-input.tsx') });
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route('https://outside.test/**', route => route.fulfill({ body: 'External content must not load' }));
  await page.setContent('<div id="root"></div><template id="html-source"></template><output id="ipc-log"></output>');
  await page.locator('#html-source').evaluate((element, source) => { element.textContent = source; }, html);
  await page.clock.install();
  await page.addScriptTag({ content: fixture });

  const editor = page.getByRole('textbox', { name: 'Editor content' });
  await expect(editor).toHaveValue(html);
  await expect(editor).toBeEditable();
  await expect(page.getByText('Read-only', { exact: false })).toHaveCount(0);
  await expect(page.locator('#root iframe, #root a, #root img, #root webview')).toHaveCount(0);

  await editor.fill(`${html}<p>edited</p>`);
  await page.clock.fastForward(1000);
  await expect(page.locator('#ipc-log')).toContainText(`"channel":"file:write"`);
  await expect(page.locator('#ipc-log')).toContainText('<p>edited</p>');

  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.locator('#ipc-log')).toContainText('{"channel":"panels:open-html-file","request":{"sessionId":"test-session","filePath":"site/page.html"}}');

  expect(await page.evaluate(() => Object.hasOwn(window, 'previewScriptRan'))).toBe(false);
  expect(requests).toEqual([]);
});
