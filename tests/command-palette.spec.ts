import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { PANES, boot, openSearch, results, selectedOption } from './commandPaletteFixture';

const SHOTS = process.env.PANE_SEARCH_SHOTS;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const theme of ['light', 'dark', 'teletype'] as const) {
  test(`finds real Panes, Sessions, projects and commands (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await boot(page, { initialConfig: { theme, appearanceMode: 'fixed' } });
    const input = await openSearch(page);
    await shoot(page, `06-empty-${theme}`);
    await input.pressSequentially('pane', { delay: 40 });
    const list = results(page);
    for (const header of ['Top hit', 'Panes', 'Sessions', 'Projects', 'Commands']) {
      await expect(list.getByText(header, { exact: true })).toBeVisible();
    }
    await expect(list.getByRole('option', { name: /, Pane$/ }).first()).toBeVisible();
    await expect(list.getByRole('option', { name: /more Panes/ })).toBeVisible();
    await expect(list.getByRole('option', { name: /^Switch to/ })).toHaveCount(0);
    await shoot(page, `01-pane-${theme}`);
  });
}

test('matches a Pane by branch, project, PR number, PR title and initials', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  for (const [query, want] of [['polish-branch', 'ui-polish-app'], ['1105', 'wsl-runpane'], ['terminals', 'wsl-runpane'], ['rpuf', 'runpane-update-fix']]) {
    await input.fill(query);
    await expect(selectedOption(page)).toContainText(want);
  }
  await input.fill('bloom-mono');
  await expect(results(page).getByRole('option', { name: /ui-polish-app/ })).toBeVisible();
  await input.fill('arch pane');
  await expect(selectedOption(page)).toContainText('Archive Pane');
});

test('Enter opens a Pane, a Session, a project or runs a command, and closes Search', async ({ page }) => {
  await boot(page, { mainRepoSessionDelayByProjectId: { 3: 60_000 } });
  let input = await openSearch(page);
  await input.fill('runpane-update-fix');
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]').first()).toBeVisible();

  input = await openSearch(page);
  await input.fill('Pane UI');
  await expect(selectedOption(page)).toHaveAttribute('aria-label', /^Pane UI, .*Session$/);
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]')).toHaveCount(0);

  input = await openSearch(page);
  await input.fill('bloom-mono');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Projects', pressed: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  // Only the project view loads a project's main repository session.
  await expect(page.getByLabel('Loading main repository session').first()).toBeVisible();

  input = await openSearch(page);
  await input.fill('> open settings');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
});

test('choosing a Pane from Search leaves Settings', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('ControlOrMeta+,');
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  const input = await openSearch(page);
  await input.fill('runpane-update-fix');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'General' })).toBeHidden();
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]').first()).toBeVisible();
});

type SearchTestMock = {
  emitSessionUpdated: (session: JsonObject) => void;
  emitSessionDeleted: (sessionId: string) => void;
};

type TestWindow = typeof window & { __paneTestElectronMock: SearchTestMock };

const emitSessionUpdated = (page: Page, session: JsonObject) => page.evaluate(next =>
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  (window as TestWindow).__paneTestElectronMock.emitSessionUpdated(next), session);

const emitSessionDeleted = (page: Page, sessionId: string) => page.evaluate(id =>
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  (window as TestWindow).__paneTestElectronMock.emitSessionDeleted(id), sessionId);

test('New Pane here from dirty Settings waits for the discard choice', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await page.getByRole('button', { name: 'Add Shortcut' }).click();

  const newPaneHere = async () => {
    await openSearch(page);
    await page.keyboard.type('bloom-mono');
    await page.keyboard.press('ControlOrMeta+K');
    await page.keyboard.type('new pane');
    await page.keyboard.press('Enter');
  };
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  const newPaneDialog = page.getByRole('dialog', { name: /New Pane in bloom-mono/ });

  await newPaneHere();
  await expect(discard).toBeVisible();
  await page.waitForTimeout(300);
  await expect(newPaneDialog).toHaveCount(0);
  await discard.getByRole('button', { name: 'Stay' }).click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(newPaneDialog).toHaveCount(0);

  await newPaneHere();
  await discard.getByRole('button', { name: 'Discard Changes' }).click();
  await expect(newPaneDialog).toBeVisible();
  await expect(page.getByTestId('settings-page')).toHaveCount(0);
});

test('clicking N more keeps typing and arrow keys in Search', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  await page.keyboard.type('pane');
  await results(page).getByRole('option', { name: /more Panes/ }).click();
  await expect(page.getByRole('button', { name: 'Panes', pressed: true })).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.type('-');
  await expect(input).toHaveValue('pane-');
});

test('Actions follow live changes to their Pane', async ({ page }) => {
  await boot(page);
  await openSearch(page);
  await page.keyboard.type('runpane-update-fix');
  await page.keyboard.press('ControlOrMeta+K');
  const actions = page.getByRole('listbox', { name: 'Actions' });
  await expect(actions.getByRole('option', { name: 'Pin', exact: true })).toBeVisible();

  const updated = PANES.find(item => item.id === 'p-update');
  await emitSessionUpdated(page, { ...updated, name: 'runpane-update-v2', isFavorite: true });
  await expect(actions.getByRole('option', { name: 'Unpin', exact: true })).toBeVisible();
  await expect(page.getByText('Actions for runpane-update-v2')).toBeVisible();

  // A Pane removed while its Actions show takes them away, back to the results.
  await emitSessionDeleted(page, 'p-update');
  await expect(results(page)).toBeVisible();
});

test('the selection survives a live removal of its row', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  await page.keyboard.type('pane');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowUp');
  const last = await selectedOption(page).getAttribute('aria-label');
  const removedName = last?.split(',')[0];
  const removed = PANES.find(item => item.name === removedName);
  expect(removed).toBeDefined();
  await emitSessionDeleted(page, String(removed?.id));
  await expect(results(page).getByRole('option', { name: new RegExp(`^${removedName},`) })).toHaveCount(0);
  await expect(selectedOption(page)).toHaveCount(1);
  await expect(input).toHaveAttribute('aria-activedescendant', /option/);
  const next = (await selectedOption(page).getAttribute('aria-label'))?.split(',')[0];
  await page.keyboard.press('Enter');
  await expect(page.locator(`[aria-current="page"][aria-label="${next}"]`).first()).toBeVisible();
});

test('Tab cycles the filters, N more opens one, and > selects Commands', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  await input.fill('pane');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Panes', pressed: true })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'All', pressed: true })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Commands', pressed: true })).toBeVisible();
  await page.keyboard.press('Tab');

  const more = results(page).getByRole('option', { name: /more Panes/ });
  await more.click();
  await expect(page.getByRole('button', { name: 'Panes', pressed: true })).toBeVisible();
  await expect(results(page).getByRole('option', { name: /more/ })).toHaveCount(0);
  // Every Pane whose name or project matches "pane" is listed.
  expect(await results(page).getByRole('option').count()).toBeGreaterThan(8);

  await input.fill('>');
  await expect(page.getByRole('button', { name: 'Commands', pressed: true })).toBeVisible();
  await expect(results(page).getByRole('option', { name: /^New Pane, Command$/ })).toBeVisible();
});

test('an empty query lists the previous Pane first, so Enter returns to it', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'runpane-update-fix', exact: true }).first().click();
  await page.getByRole('button', { name: 'spotlight-search', exact: true }).first().click();
  await openSearch(page);
  const list = results(page);
  await expect(list.getByText('Recent', { exact: true })).toBeVisible();
  await expect(list.getByText('Suggested', { exact: true })).toBeVisible();
  await expect(list.getByRole('option', { name: /spotlight-search/ })).toHaveCount(0);
  await expect(selectedOption(page)).toContainText('runpane-update-fix');
  await page.keyboard.press('Enter');
  await expect(page.locator('[aria-current="page"][aria-label="runpane-update-fix"]').first()).toBeVisible();
});

test('⌘K shows the selected row’s actions, filters them, and Esc goes back', async ({ page }) => {
  await boot(page, { initialConfig: { theme: 'teletype', appearanceMode: 'fixed' } });
  await page.setViewportSize({ width: 1400, height: 900 });
  const input = await openSearch(page);
  await input.fill('wsl-runpane');
  await page.keyboard.press('ControlOrMeta+K');
  const actions = page.getByRole('listbox', { name: 'Actions' });
  for (const label of ['Open Pane', 'Open in IDE', 'Copy worktree path', 'Open pull request', 'Pin', 'Archive']) {
    await expect(actions.getByRole('option', { name: label, exact: true })).toBeVisible();
  }
  await shoot(page, '07-actions-teletype');
  await input.fill('pull');
  await expect(actions.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(results(page)).toBeVisible();
  await expect(input).toHaveValue('wsl-runpane');
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();

  // Archive asks the usual confirmation.
  await openSearch(page);
  await page.keyboard.type('wsl-runpane');
  await page.keyboard.press('ControlOrMeta+K');
  await page.keyboard.type('archive');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Archive Make runpane work in Pane’s WSL terminals?' })).toContainText('Its agents stop and its git worktree is removed');
});

test('Search is centered in the window and fully on screen at any width', async ({ page }) => {
  await page.setViewportSize({ width: 1754, height: 1000 });
  await boot(page);
  await openSearch(page);
  const panel = page.getByRole('dialog').locator('> div').first();
  for (const width of [1754, 1000, 600]) {
    await page.setViewportSize({ width, height: 1000 });
    const box = await panel.boundingBox();
    if (!box) throw new Error('Search panel has no box');
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - 500)).toBeLessThanOrEqual(1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
});

test('the sidebar field and the rail icon open Search ready to type', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await boot(page, { initialConfig: { theme: 'teletype', appearanceMode: 'fixed' } });
  const sidebar = page.getByTestId('sidebar');
  await shoot(page, '08-sidebar-teletype');
  await sidebar.getByRole('button', { name: /^Search/ }).click();
  await page.keyboard.type('posthog');
  await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toHaveValue('posthog');
  await page.keyboard.press('Escape');

  await page.keyboard.press('ControlOrMeta+B');
  await page.getByTestId('sidebar').getByRole('button', { name: 'Search', exact: true }).click();
  await page.keyboard.type('loops');
  await expect(page.getByRole('combobox', { name: 'Search', exact: true })).toHaveValue('loops');
});

test('disabled commands are listed last and do not run', async ({ page }) => {
  await boot(page, { activePaneId: '' });
  const input = await openSearch(page);
  // With no Pane open, Archive Pane is unavailable.
  await input.fill('> pane');
  const options = results(page).getByRole('option');
  await expect(options.last()).toHaveAttribute('aria-disabled', 'true');
  await options.last().dispatchEvent('click');
  await expect(input).toBeVisible();
});

test('opens with shortcuts off when its shortcut is kept on', async ({ page }) => {
  await boot(page, { initialConfig: { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true } });
  await openSearch(page);
});

test('shows only the empty state when nothing matches', async ({ page }) => {
  await boot(page);
  const input = await openSearch(page);
  await input.pressSequentially('panezzzznothing', { delay: 20 });
  await expect(results(page).getByText('No results')).toBeVisible();
  await expect(results(page).getByRole('option')).toHaveCount(0);
});
