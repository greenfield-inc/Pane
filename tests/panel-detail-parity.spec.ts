import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 923, name: 'Panel parity fixture', path: '/tmp/panel-parity', active: true, created_at: now, updated_at: now, open_ide_command: 'zed .' };
const session = {
  id: 'parity-pane', name: 'Parity pane', projectId: project.id, worktreePath: '/tmp/panel-parity/branch',
  prompt: '', status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', displayOrder: 0, isFavorite: false, toolType: 'none', archived: false, baseBranch: 'origin/main',
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};

async function openPane(page: Page, mainRepo: boolean): Promise<void> {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [{ ...session, isMainRepo: mainRepo }], activeProjectId: project.id,
    gitCommands: { currentBranch: 'feature/layout', fetch: 'git fetch', pull: 'git pull', push: 'git push' },
    initialPanels: [{ id: 'parity-dock', sessionId: session.id, type: 'terminal', title: 'Terminal', state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } }, metadata: { createdAt: now, lastActiveAt: now, position: 0, permanent: true } }, ...['First', 'Second', 'Third'].map((title, position) => ({
      id: `parity-panel-${position}`, sessionId: session.id, type: 'logs', title,
      state: { isActive: position === 0, hasBeenViewed: true }, metadata: { createdAt: now, lastActiveAt: now, position: position + 1 },
    }))],
  });
  await page.goto('/');
  if (mainRepo) {
    await page.getByRole('button', { name: 'Repository actions for Panel parity fixture', exact: true }).click();
    await page.getByText('Open session on main', { exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Expand repository Panel parity fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Parity pane', exact: true }).click();
  }
  await expect(page.getByRole('tab', { name: 'First', exact: true })).toHaveAttribute('aria-selected', 'true');
}

for (const mainRepo of [true, false]) {
  test(`${mainRepo ? 'main repository' : 'worktree'} closing background tabs preserves selection and active closes choose a neighbour`, async ({ page }, testInfo) => {
    await openPane(page, mainRepo);
    await page.getByRole('button', { name: 'Close Third', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Third', exact: true })).toBeHidden();
    await expect(page.getByRole('tab', { name: 'First', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Close First', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Second', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: testInfo.outputPath('close-selection.png') });
  });
}

test('horizontal details offers tracking and retains the vertical branch label and IDE choices', async ({ page }, testInfo) => {
  await openPane(page, false);
  await page.getByRole('tab', { name: 'Details', exact: true }).click();
  const vertical = page.locator('.pane-detail-panel-vertical');
  await expect(vertical.getByText('feature/layout', { exact: true })).toBeVisible();
  await vertical.getByRole('button', { name: 'Open in IDE', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /zed/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /VS Code/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Cursor/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Swap terminal and detail panel positions', exact: true }).click();
  const horizontal = page.locator('.pane-detail-panel-horizontal');
  await expect(horizontal.getByText('feature/layout', { exact: true })).toBeVisible();
  await horizontal.getByRole('button', { name: 'Set Tracking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set Tracking Branch', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await horizontal.getByRole('button', { name: 'Open in IDE', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /zed/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /VS Code/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Cursor/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('horizontal-details.png') });
});
