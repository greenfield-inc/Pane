import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 1,
  name: 'Scheduled QA',
  path: '/tmp/scheduled-qa',
  active: true,
  created_at: '2026-08-23T00:00:00.000Z',
  updated_at: '2026-08-23T00:00:00.000Z',
};

const scheduledSession = {
  id: 'scheduled-session-1',
  name: 'Scheduled result',
  projectId: 1,
  worktreePath: '/tmp/scheduled-result',
  prompt: 'Review the latest changes',
  status: 'stopped',
  createdAt: '2026-08-23T00:00:00.000Z',
  lastActivity: '2026-08-23T00:00:00.000Z',
  output: [],
  jsonMessages: [],
  permissionMode: 'ignore',
  toolType: 'claude',
  archived: false,
  isHidden: false,
  isFavorite: false,
};

test('manages a scheduled run and opens its resulting session', async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [scheduledSession],
    activeProjectId: project.id,
    initialUiState: {
      expandedProjects: [project.id],
      repositoriesSectionExpanded: true,
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: `Repository actions for ${project.name}` }).click();
  await page.getByText('Scheduled runs', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scheduled runs' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('No scheduled runs yet.')).toBeVisible();
  await page.screenshot({ path: 'tmp/pr-386-qa/01-empty-scheduled-runs.png' });

  await page.getByRole('button', { name: 'New scheduled run' }).click();
  await page.getByPlaceholder('Nightly sweep').fill('QA sweep');
  await page.getByPlaceholder('Look for flaky tests and open an issue for each one you can reproduce.')
    .fill('Review the latest changes');
  await page.getByLabel('Repeats').selectOption('weekly');
  await dialog.getByRole('combobox').nth(2).selectOption('2');
  await dialog.getByRole('textbox', { name: 'At', exact: true }).fill('09:15');
  await page.screenshot({ path: 'tmp/pr-386-qa/02-weekly-schedule-form.png' });
  await page.getByRole('button', { name: 'Save schedule' }).click();

  await expect(page.getByText('QA sweep', { exact: true })).toBeVisible();
  await expect(page.getByText(/Every Tuesday at 09:15/)).toBeVisible();
  await page.getByTitle('Pause').click();
  await expect(page.getByTitle('Resume')).toBeVisible();
  await page.getByTitle('Run now, without moving the schedule').click();
  await expect(page.getByRole('button', { name: 'Open last session' })).toBeVisible();
  await page.screenshot({ path: 'tmp/pr-386-qa/03-run-complete-and-paused.png' });

  await page.getByRole('button', { name: 'Open last session' }).click();
  await expect(page.getByText('Scheduled result', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
