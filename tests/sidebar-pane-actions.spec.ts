import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './axeTest';
import { installElectronApiMock } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

const project = {
  id: 1, name: 'Alpha', path: '/tmp/alpha', active: true,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
};
const regular = {
  id: 'regular', name: 'Regular work', projectId: 1, worktreePath: '/tmp/regular', prompt: '',
  status: 'stopped', createdAt: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-01T00:00:00.000Z',
  output: [], jsonMessages: [], permissionMode: 'ignore', toolType: 'none', archived: false,
  isHidden: false, isFavorite: true, favoritePinnedAt: '2026-01-02T00:00:00.000Z',
};

async function setup(page: Parameters<typeof installElectronApiMock>[0]) {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [regular],
    initialUiState: { expandedProjects: [1], pinnedSectionExpanded: true, repositoriesSectionExpanded: true },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

test.describe('sidebar pane actions', () => {
  for (const status of ['blocked', 'working', 'idle', 'done'] as const) {
    test(`shows accessible ${status} status in expanded and compact rows`, async ({ page }) => {
      const events = status === 'done'
        ? [
          { panelId: 'panel-regular', sessionId: 'regular', state: 'working' as const },
          { panelId: 'panel-regular', sessionId: 'regular', state: 'idle' as const },
        ]
        : [{ panelId: 'panel-regular', sessionId: 'regular', state: status }];
      await installElectronApiMock(page, {
        initialProjects: [project],
        initialSessions: [{ ...regular, isFavorite: false }],
        initialAgentStatusEvents: events,
        initialUiState: { expandedProjects: [1], repositoriesSectionExpanded: true },
      });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      const label = status === 'done' ? 'done' : status;
      const expandedRow = page.getByRole('button', { name: 'Regular work', exact: true });
      await expect(expandedRow.locator('..').getByRole('status', { name: `Agent ${label}` })).toHaveCount(1);
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await expect(page.getByTestId('compact-repository-pane-regular').getByRole('status', { name: `Agent ${label}` })).toHaveCount(1);
    });
  }

  test('renames from expanded and compact context menus and restores focus', async ({ page }) => {
    await setup(page);
    const pinnedRow = page.getByRole('button', { name: 'Alpha/Regular work', exact: true });
    await pinnedRow.click({ button: 'right' });
    const pinnedMenu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    await expect(pinnedMenu).toBeVisible();
    await expect(pinnedMenu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(pinnedMenu).toBeHidden();

    const row = page.getByRole('button', { name: 'Regular work', exact: true }).last();
    await row.click();
    await row.click({ button: 'right' });
    let menu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Unpin', 'Move chat to Session…', 'Rename worktree…', 'Archive']);
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Pane name' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Pane name' }).press('Escape');
    await expect(row).toBeFocused();
    await row.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
    await row.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    await expectNoAxeViolations(page);
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click();

    const input = page.getByRole('textbox', { name: 'Pane name' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Regular work');
    await expectNoAxeViolations(page);
    await input.fill('  Human label  ');
    await input.press('Enter');

    await expect.poll(() => page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getSessionRenameCalls: () => Array<[string, string]> } }
    ).__paneTestElectronMock.getSessionRenameCalls())).toEqual([['regular', 'Human label']]);
    const renamed = page.getByRole('button', { name: 'Human label', exact: true }).last();
    await expect(renamed).toBeFocused();
    await expect(page).toHaveTitle(/Human label/);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const compact = page.getByTestId('compact-repository-pane-regular');
    await expect(compact).toHaveAttribute('aria-label', /Human label/);
    await compact.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Pane actions for Human label' });
    await expect(menu.getByRole('menuitem').first()).toHaveText('Rename');
    await page.getByTestId('compact-pinned-pane-regular').click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Pane actions for Human label' })).toBeVisible();
  });

  test('keeps a renamed label after renderer reload and PR/commit refresh', async ({ page, context }) => {
    await setup(page);
    const row = page.getByRole('button', { name: 'Regular work', exact: true }).last();
    await row.click();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Pane name' }).fill('Human label');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Human label', exact: true })).toBeVisible();
    const response = await page.evaluate(() => window.electronAPI.sessions.getAll());
    expect(response.success).toBe(true);
    // A new renderer hydrates the backend response; SQLite restart is covered in the main test.
    const restored = await context.newPage();
    await installElectronApiMock(restored, {
      initialProjects: [project], initialSessions: response.data,
      initialUiState: { expandedProjects: [1], pinnedSectionExpanded: true, repositoriesSectionExpanded: true },
    });
    await restored.goto('/', { waitUntil: 'domcontentloaded' });
    const restoredRow = restored.getByRole('button', { name: 'Human label', exact: true });
    await restoredRow.click();
    await restored.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { emitGitStatusUpdated: (id: string, status: JsonObject) => void } }
    ).__paneTestElectronMock.emitGitStatusUpdated('regular', {
      state: 'ahead', ahead: 3, prNumber: 42, prTitle: 'Latest PR title', prState: 'OPEN',
      commitAdditions: 20, commitDeletions: 4, commitFilesChanged: 2,
    }));
    await expect(restoredRow).toBeVisible();
    await expect(restored.getByRole('button', { name: 'Alpha/Human label', exact: true })).toBeVisible();
    await expect(restored).toHaveTitle(/Human label/);
    await restored.mouse.move(800, 500);
    await restoredRow.hover();
    await expect(restored.getByRole('tooltip')).toContainText('Latest PR title');
    await restored.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(restored.getByTestId('compact-repository-pane-regular')).toHaveAttribute('aria-label', /Human label/);
    await restored.close();
  });

  test('rejects blank names and cancels without a rename call', async ({ page }) => {
    await setup(page);
    const row = page.getByRole('button', { name: 'Regular work', exact: true }).last();
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Pane name' });
    await input.fill('   ');
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(page.getByText('Pane name cannot be blank')).toBeVisible();
    await input.press('Enter');
    await input.press('Escape');
    await expect.poll(() => page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getSessionRenameCalls: () => Array<[string, string]> } }
    ).__paneTestElectronMock.getSessionRenameCalls())).toEqual([]);
    await expect(page.getByRole('button', { name: 'Regular work', exact: true }).last()).toBeVisible();
  });

  test('keeps stored labels and PR metadata while using neutral rows and an accessible badge', async ({ page }) => {
    await installElectronApiMock(page, {
      initialProjects: [project],
      initialSessions: [{ ...regular, isFavorite: false, gitStatus: { state: 'ahead', prNumber: 42, prTitle: 'PR title', prState: 'OPEN' } }],
      initialUiState: { expandedProjects: [1], repositoriesSectionExpanded: true },
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const row = page.getByRole('button', { name: 'Regular work', exact: true });
    await expect(row).toBeVisible();
    await expect(row.locator('..')).toContainText('#42');
    await row.hover();
    await expect(page.getByRole('tooltip')).toContainText('PR title');
    await expect(row.locator('..').getByRole('status', { name: 'Agent status unknown' })).toHaveCount(1);
    await expect(page.locator('.absolute.left-0.top-0.bottom-0.w-1')).toHaveCount(0);
    await expect(page.locator('.animate-sidebar-active-label, .animate-status-working')).toHaveCount(0);
    await row.click();
    await expect(row.locator('..')).toHaveClass(/bg-surface-selected/);
    await page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { emitGitStatusUpdated: (id: string, status: JsonObject) => void } }
    ).__paneTestElectronMock.emitGitStatusUpdated('regular', { state: 'ahead', prNumber: 42, prTitle: 'Changed PR title' }));
    await expect(row).toHaveAccessibleName('Regular work');
  });
});
