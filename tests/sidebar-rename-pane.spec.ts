import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

const projects = [
  {
    id: 1,
    name: 'Alpha',
    path: '/tmp/alpha',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
];

function session(id: string, name: string, overrides: JsonObject = {}) {
  return {
    id,
    name,
    projectId: 1,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'stopped',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    permissionMode: 'ignore',
    toolType: 'none',
    archived: false,
    isHidden: false,
    isFavorite: false,
    ...overrides,
  };
}

async function openSidebarWithPane(page: Page, name: string, overrides: JsonObject = {}) {
  await installElectronApiMock(page, {
    initialConfig: { theme: 'night-owl' },
    initialProjects: projects,
    initialSessions: [session('pane-rename', name, overrides)],
    initialUiState: {
      expandedProjects: [1],
      pinnedSectionExpanded: true,
      repositoriesSectionExpanded: true,
    },
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 30_000 });
}

async function renameCalls(page: Page) {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (
    window as typeof window & {
      __paneTestElectronMock: { getSessionRenameCalls: () => Array<{ sessionId: string; name: string }> };
    }
  ).__paneTestElectronMock.getSessionRenameCalls());
}

test.describe('sidebar pane rename', () => {
  test('double-click renames the pane and Enter commits the new name', async ({ page }) => {
    await openSidebarWithPane(page, 'Old pane name');

    await page.getByRole('button', { name: 'Old pane name', exact: true }).dblclick();

    const input = page.getByTestId('session-rename-input-pane-rename');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Old pane name');

    await input.fill('New pane name');
    await input.press('Enter');

    await expect(input).toHaveCount(0);
    expect(await renameCalls(page)).toEqual([{ sessionId: 'pane-rename', name: 'New pane name' }]);
    await expect(page.getByRole('button', { name: 'New pane name', exact: true })).toBeVisible();
  });

  test('Escape cancels the rename without calling the backend', async ({ page }) => {
    await openSidebarWithPane(page, 'Old pane name');

    await page.getByRole('button', { name: 'Old pane name', exact: true }).dblclick();

    const input = page.getByTestId('session-rename-input-pane-rename');
    await input.fill('Discarded name');
    await input.press('Escape');

    await expect(input).toHaveCount(0);
    expect(await renameCalls(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Old pane name', exact: true })).toBeVisible();
  });

  // The main repo session is held twice in the session store (in the sessions
  // list and as activeMainRepoSession), so a rename has to reach both copies.
  test('renaming the active main repo pane updates the sidebar label', async ({ page }) => {
    await openSidebarWithPane(page, 'Old pane name', { isMainRepo: true });

    const row = page.getByRole('button', { name: 'Old pane name', exact: true });
    await row.click();
    await row.dblclick();

    const input = page.getByTestId('session-rename-input-pane-rename');
    await input.fill('New pane name');
    await input.press('Enter');

    await expect(page.getByRole('button', { name: 'New pane name', exact: true })).toBeVisible();
  });

  test('an empty name is discarded instead of clearing the pane title', async ({ page }) => {
    await openSidebarWithPane(page, 'Old pane name');

    await page.getByRole('button', { name: 'Old pane name', exact: true }).dblclick();

    const input = page.getByTestId('session-rename-input-pane-rename');
    await input.fill('   ');
    await input.press('Enter');

    await expect(input).toHaveCount(0);
    expect(await renameCalls(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Old pane name', exact: true })).toBeVisible();
  });
});
