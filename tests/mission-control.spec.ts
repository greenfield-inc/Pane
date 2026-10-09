import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 1,
  name: 'Alpha',
  path: '/tmp/alpha',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const session = {
  id: 'agent-session',
  name: 'Agent session',
  projectId: 1,
  worktreePath: '/tmp/alpha-agent',
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
};

const agent = {
  panelId: 'agent-panel',
  sessionId: session.id,
  sessionName: session.name,
  projectId: 1,
  projectName: 'Alpha',
  worktreePath: session.worktreePath,
  worktreeName: 'alpha-agent',
  panelTitle: 'Claude',
  agentType: 'claude',
  isPermanent: false,
  isLive: true,
};

async function boot(page: Page, initialConfig: JsonObject = {}) {
  await installElectronApiMock(page, {
    initialConfig,
    initialProjects: [project],
    initialSessions: [session],
    initialMissionControlAgents: [agent],
    initialUiState: { expandedProjects: [1], repositoriesSectionExpanded: true },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByTestId('sidebar').first()).toBeVisible({ timeout: 10_000 });
}

async function setMissionControlSetting(page: Page, enabled: boolean) {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Mission Control' });
  await expect(toggle).toHaveAttribute('aria-checked', String(!enabled));
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(enabled));
  await page.getByRole('button', { name: 'Back', exact: true }).click();
}

const missionControlHeading = (page: Page) => page.getByRole('heading', { name: 'Mission Control', level: 1 });

test.describe('Mission Control experimental setting', () => {
  test('stays out of the sidebar until the setting is turned on', async ({ page }) => {
    await boot(page);
    await expect(page.getByText('Agent session').first()).toBeVisible();
    await expect(page.getByTestId('mission-control-nav')).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('navigation', { name: 'Compact sidebar' })).toBeVisible();
    await expect(page.getByTestId('compact-mission-control')).toHaveCount(0);

    await setMissionControlSetting(page, true);
    await page.getByTestId('compact-mission-control').click();
    await expect(missionControlHeading(page)).toBeVisible();
    await expect(page.getByText('snapshot for agent-panel')).toBeVisible();
  });

  test('leaves the grid when the setting is turned off', async ({ page }) => {
    await boot(page, { missionControlEnabled: true });
    await page.getByTestId('mission-control-nav').click();
    await expect(missionControlHeading(page)).toBeVisible();

    await setMissionControlSetting(page, false);
    await expect(missionControlHeading(page)).toHaveCount(0);
    await expect(page.getByTestId('mission-control-nav')).toHaveCount(0);
  });
});
