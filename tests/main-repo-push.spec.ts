import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 1,
  name: 'bloomapi/bloom-mono',
  path: '/tmp/bloom-mono',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const baseSession = {
  prompt: 'Verify the title bar',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};

const mainRepoSession = {
  ...baseSession,
  id: 'title-bar-main-repo',
  name: 'bloom-mono',
  worktreePath: '/tmp/bloom-mono',
  isMainRepo: true,
  displayOrder: 1,
};

test('publishing the main checkout refreshes tracking only after a successful push', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [{ ...mainRepoSession, gitStatus: { state: 'ahead', ahead: 1, behind: 0, hasUncommittedChanges: false } }],
    activeProjectId: project.id,
    gitCommands: { currentBranch: 'feature', mainBranch: 'main' },
  });
  await page.addInitScript(() => {
    let upstream: string | null = null;
    let attempts = 0;
    window.electronAPI.sessions.getUpstream = async () => ({ success: true, data: upstream });
    window.electronAPI.sessions.gitPush = async () => {
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'Remote rejected publication' };
      upstream = 'origin/feature';
      return { success: true };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  if (await page.getByRole('button', { name: 'Show details', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Show details', exact: true }).click();
  }
  const push = page.locator('.pane-detail-panel-vertical').getByRole('button', { name: /^Push/ });
  await push.hover();
  await expect(page.getByRole('tooltip')).toContainText('Publish feature to origin and set its upstream');
  await push.click();
  await expect(page.getByText('Remote rejected publication', { exact: true })).toBeVisible();
  await push.hover();
  await expect(page.getByRole('tooltip')).toContainText('Publish feature to origin and set its upstream');
  await push.click();
  await expect(page.getByText('Remote rejected publication', { exact: true })).toHaveCount(0);
  await push.hover();
  await expect(page.getByRole('tooltip')).toContainText('Push 1 commit(s) from feature');
  await page.screenshot({ path: testInfo.outputPath('published-upstream.png') });
});
