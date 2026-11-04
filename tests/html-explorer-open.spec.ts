import { expect, test, type Page } from '@playwright/test';
import { bundleFixture } from './fixtures/bundle';

interface Log { calls: string[]; panels: string[]; active: string | null; shown: string | null }

async function mount(page: Page) {
  const fixture = await bundleFixture('html-explorer-open');
  await page.setContent('<div id="root" style="height:400px"></div><output id="ipc-log"></output>');
  await page.addScriptTag({ content: fixture });
  await expect(page.getByText('index.html')).toBeVisible();
}

async function log(page: Page): Promise<Log> {
  return JSON.parse(await page.locator('#ipc-log').textContent() || '{"calls":[],"panels":[],"active":null,"shown":null}');
}

test('clicking an HTML file twice focuses the tab already showing it', async ({ page }) => {
  await mount(page);
  await page.getByText('index.html').click();
  await expect.poll(async () => (await log(page)).shown).toBe('panel-2');
  await page.evaluate(() => window.dispatchEvent(new Event('show-terminal')));
  await expect.poll(async () => (await log(page)).shown).toBe('panel-1');
  await page.getByText('index.html').click();
  await expect.poll(async () => (await log(page)).calls.filter(call => call === 'panels:open-html-file').length).toBe(2);

  const { panels, active, shown, calls } = await log(page);
  expect(panels).toEqual(['terminal', 'browser']);
  expect(active).toBe('panel-2');
  expect(shown).toBe('panel-2');
  expect(calls).not.toContain('panels:create');
});

test('an HTML file\'s context menu opens the preview or the editable source', async ({ page }) => {
  await mount(page);
  await page.getByText('index.html').click({ button: 'right' });
  const items = page.getByRole('button', { name: /^Open (preview in browser|as file)$/ });
  await expect(items).toHaveText(['Open preview in browser', 'Open as file']);

  await page.getByRole('button', { name: 'Open preview in browser' }).click();
  await expect.poll(async () => (await log(page)).panels).toEqual(['terminal', 'browser']);
  await expect.poll(async () => (await log(page)).shown).toBe('panel-2');
  await expect(page.getByRole('button', { name: 'Open as file' })).toHaveCount(0);

  await page.getByText('index.html').click({ button: 'right' });
  await page.getByRole('button', { name: 'Open as file' }).click();
  await expect.poll(async () => (await log(page)).panels).toEqual(['terminal', 'browser', 'editor']);
  expect((await log(page)).calls.filter(call => call === 'panels:open-html-file')).toHaveLength(1);
});

test('other files get no HTML open options', async ({ page }) => {
  await mount(page);
  await page.getByText('app.ts').click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Open (preview in browser|as file)$/ })).toHaveCount(0);
});
