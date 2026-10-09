import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

const html = '<!doctype html><meta http-equiv="refresh" content="0;url=https://outside.test/refresh"><style>@import "https://outside.test/style";</style><script>window.previewScriptRan = true</script><img src="https://outside.test/image"><a href="https://outside.test/page">External link</a>';

test('HTML stays read-only source with inert scripts, links and resource references', async ({ page }) => {
  const { outputFiles } = await build({
    entryPoints: [path.resolve('tests/fixtures/html-preview-source.tsx')],
    alias: { '@monaco-editor/react': path.resolve('tests/fixtures/editor-input.tsx') },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
  });
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.route('https://preview.test/**', route => route.fulfill({ body: html, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/html' } }));
  await page.route('https://outside.test/**', route => route.fulfill({ body: 'External content must not load' }));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: outputFiles[0].text });
  await expect(page.getByRole('textbox')).toHaveValue(html);
  await expect(page.getByRole('textbox')).not.toBeEditable();
  await expect(page.locator('iframe, a, img')).toHaveCount(0);
  await page.getByRole('textbox').click();
  await page.keyboard.type('must not modify the source');
  await expect(page.getByRole('textbox')).toHaveValue(html);
  expect(await page.evaluate(() => Object.hasOwn(window, 'previewScriptRan'))).toBe(false);
  expect(requests).toEqual(['https://preview.test/untrusted.html']);
});
