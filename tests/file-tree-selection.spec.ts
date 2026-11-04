import { expect, test, type Page } from '@playwright/test';
import { bundleFixture } from './fixtures/bundle';

let fixture: string;
test.beforeAll(async () => {
  fixture = await bundleFixture('file-tree-selection');
});

const row = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });
const selectedRows = (page: Page) => page.locator('[role=treeitem][aria-selected=true]');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(async ({ page }) => {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: fixture });
  await expect(row(page, 'CLAUDE.md')).toBeVisible();
});

test('a plain click on a folder or file replaces the selection', async ({ page }) => {
  await row(page, 'AGENTS.md').click();
  await expect(selectedRows(page)).toHaveText(['AGENTS.md']);
  await row(page, 'plans').click();
  await expect(selectedRows(page)).toHaveText(['plans']);
  await row(page, 'CLAUDE.md').click();
  await expect(selectedRows(page)).toHaveText(['CLAUDE.md']);
});

test('opening an HTML file outside the editor leaves only that row selected', async ({ page }) => {
  await row(page, 'AGENTS.md').click();
  await row(page, 'plans').click();
  await row(page, 'cows.html').click();
  await expect(page.getByLabel('Active editor path')).toHaveText('AGENTS.md');
  await expect(selectedRows(page)).toHaveText(['cows.html']);
});

test('cmd/ctrl-click toggles a row into the selection without opening it', async ({ page }) => {
  await row(page, 'AGENTS.md').click();
  await row(page, 'CLAUDE.md').click({ modifiers: [modifier] });
  await expect(selectedRows(page)).toHaveText(['AGENTS.md', 'CLAUDE.md']);
  await expect(page.getByLabel('Opened')).toHaveText('AGENTS.md');
  await row(page, 'CLAUDE.md').click({ modifiers: [modifier] });
  await expect(selectedRows(page)).toHaveText(['AGENTS.md']);
});

test('shift-click selects a range from the last plain click without opening files', async ({ page }) => {
  await row(page, 'plans').click();
  await expect(row(page, 'cows.html')).toBeVisible();
  await row(page, 'AGENTS.md').click({ modifiers: ['Shift'] });
  await expect(selectedRows(page)).toHaveText(['plans', 'cows.html', 'AGENTS.md']);
  await row(page, 'cows.html').click({ modifiers: ['Shift'] });
  await expect(selectedRows(page)).toHaveText(['plans', 'cows.html']);
  await expect(page.getByLabel('Opened')).toHaveText('');
});

test('right-click selects only an unselected row and keeps a selection it is part of', async ({ page }) => {
  const confirms: string[] = [];
  page.on('dialog', dialog => { confirms.push(dialog.message()); void dialog.dismiss(); });

  await row(page, 'AGENTS.md').click();
  await row(page, 'CLAUDE.md').click({ button: 'right' });
  await expect(selectedRows(page)).toHaveText(['CLAUDE.md']);
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => confirms).toEqual(['Move file "CLAUDE.md" to trash?']);

  await row(page, 'AGENTS.md').click();
  await row(page, 'CLAUDE.md').click({ modifiers: [modifier] });
  await row(page, 'AGENTS.md').click({ button: 'right' });
  await expect(selectedRows(page)).toHaveText(['AGENTS.md', 'CLAUDE.md']);
  await page.getByRole('button', { name: 'Move to Trash' }).click();
  await expect.poll(() => confirms).toEqual(['Move file "CLAUDE.md" to trash?', 'Move 2 items to trash?']);
});
