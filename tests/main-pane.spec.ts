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

const mainPane = {
  id: 'main-pane',
  name: '(Main) bloom-mono',
  prompt: '',
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
  worktreePath: project.path,
  isMainRepo: true,
  displayOrder: 1,
};

test('a repository opens its (Main) Pane, listed and shown like any other Pane', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: [mainPane] });
  await page.goto('/');

  await page.getByRole('button', { name: `Expand project ${project.name}`, exact: true }).click();
  await expect(page.getByText('(Main) bloom-mono', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: `Project actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open (Main) Pane', { exact: true }).click();

  await expect(page.getByText('Opening repository…')).toHaveCount(0);
  await expect(page).toHaveTitle('bloomapi/bloom-mono · (Main) bloom-mono');
  // The ordinary Pane view: the checkout gets pull and push, not worktree-only actions.
  await expect(page.getByRole('button', { name: /^Push/ }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('main-pane-open.png') });
});

test('says what happened when the (Main) Pane cannot be opened', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [],
    mainRepoSessionErrorByProjectId: { [project.id]: 'Repository folder is missing' },
  });
  await page.goto('/');
  await page.getByRole('button', { name: `Project actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open (Main) Pane', { exact: true }).click();

  await expect(page.getByRole('alert')).toContainText("Couldn't open this repository's (Main) Pane: Repository folder is missing.");
  await page.screenshot({ path: testInfo.outputPath('main-pane-error.png') });
});
