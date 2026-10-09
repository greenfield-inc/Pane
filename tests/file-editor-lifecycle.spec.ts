import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

let fixture: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve('tests/fixtures/file-editor-lifecycle.tsx')],
    alias: { '@monaco-editor/react': path.resolve('tests/fixtures/editor-input.tsx') },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  fixture = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="root"></div>');
  await page.clock.install();
  await page.addScriptTag({ content: fixture });
  await expect(page.getByLabel('Pending reads')).toHaveText('a.txt');
  await page.getByRole('button', { name: 'Resolve read' }).click();
  await expect(page.getByRole('textbox', { name: 'Editor content' })).toHaveValue('disk content');
});

test('typing during a deferred same-file refresh stays dirty and saves the user buffer', async ({ page }) => {
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByLabel('Pending reads')).toHaveText('a.txt');
  await page.getByRole('textbox').fill('user edits during refresh');
  await expect(page.getByText('Auto-saving...', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resolve read' }).click();
  await expect(page.getByRole('textbox')).toHaveValue('user edits during refresh');
  await page.clock.fastForward(1000);
  await expect(page.getByLabel('Saved files')).toHaveText('[{"sessionId":"test-session","filePath":"a.txt","content":"user edits during refresh"}]');
});

test('A to B to A cancels the pending retarget and leaves A editable and refreshable', async ({ page }) => {
  await page.getByRole('button', { name: 'Select B' }).click();
  await expect(page.getByLabel('Pending reads')).toHaveText('b.txt');
  await expect(page.getByRole('textbox')).not.toBeEditable();
  await page.getByRole('button', { name: 'Select A' }).click();
  await expect(page.getByRole('textbox')).toBeEditable();
  await page.getByRole('button', { name: 'Resolve read' }).click();
  await page.getByRole('textbox').fill('user edits after cancelling B');
  await page.clock.fastForward(1000);
  await expect(page.getByLabel('Saved files')).toHaveText('[{"sessionId":"test-session","filePath":"a.txt","content":"user edits after cancelling B"}]');
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByLabel('Pending reads')).toHaveText('a.txt');
});
