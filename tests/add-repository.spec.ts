import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './axeTest';
import { installElectronApiMock } from './electronApiMock';

async function openAddDialog(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New Project', exact: true }).click();
  await expect(page.getByText('Add New Repository')).toBeVisible();
}

async function fillRepository(page: Page, name = 'New repo') {
  await page.getByPlaceholder('Enter project name').fill(name);
  await page.getByPlaceholder('/path/to/your/repository').fill(`/tmp/${name.replaceAll(' ', '-').toLowerCase()}`);
}

test.describe('add repository default agent', () => {
  test('discloses the agent, sends the flag, and prevents duplicate submission while starting', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { defaultOrchestratorAgent: 'codex' },
      projectCreateDelayMs: 1500,
      projectCreateLaunchResult: {
        status: 'launched', agentType: 'codex', agentTitle: 'Codex', initialCommand: 'codex --yolo',
        sessionId: 'main-1', panelId: 'panel-1',
      },
    });
    await openAddDialog(page);
    await expect(page.getByText(/Creating this repository will start/)).toContainText('Codex');
    await expect(page.getByText(/Creating this repository will start/)).toContainText('codex --yolo');
    await expectNoAxeViolations(page);
    await fillRepository(page);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('button', { name: 'Starting Codex…' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Add New Repository')).toBeVisible();
    await expect(page.getByText('Add New Repository')).toBeHidden({ timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getProjectCreateCalls: () => Array<{ launchDefaultAgent?: boolean; disclosedAgent?: string }> } }
    ).__paneTestElectronMock.getProjectCreateCalls()[0])).toMatchObject({
      launchDefaultAgent: true,
      disclosedAgent: 'codex',
    });
    await expect(page.getByTestId('workspace-entry-launch-notice')).toHaveCount(0);
  });

  test('offers one manual Open agent action after launch failure', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { defaultOrchestratorAgent: 'codex' },
      projectCreateLaunchResult: {
        status: 'failed', agentType: 'codex', agentTitle: 'Codex', initialCommand: 'codex --yolo',
        reason: 'launch-error', message: 'Executable exited',
      },
    });
    await openAddDialog(page);
    await fillRepository(page);
    await page.getByRole('button', { name: 'Create' }).click();
    const notice = page.getByTestId('workspace-entry-launch-notice');
    await expect(notice).toContainText('Codex');
    await expect(notice).toContainText('Executable exited');
    await notice.getByRole('button', { name: 'Open agent' }).click();
    await expect(notice).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getPanelCreateCalls: () => Array<{ initialState?: { customState?: object } }> } }
    ).__paneTestElectronMock.getPanelCreateCalls())).toHaveLength(1);
    const call = await page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getPanelCreateCalls: () => Array<{ initialState?: { customState?: object } }> } }
    ).__paneTestElectronMock.getPanelCreateCalls()[0]);
    expect(call.initialState?.customState).toMatchObject({ initialCommand: 'codex --yolo', agentType: 'codex', isCliPanel: true });
  });

  test('dismisses a failure without opening a panel', async ({ page }) => {
    await installElectronApiMock(page, {
      projectCreateLaunchResult: {
        status: 'failed', agentType: 'claude', agentTitle: 'Claude Code',
        initialCommand: 'claude --dangerously-skip-permissions', reason: 'launch-error', message: 'Failed',
      },
    });
    await openAddDialog(page);
    await fillRepository(page);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByTestId('workspace-entry-launch-notice').getByRole('button', { name: 'Dismiss' }).click();
    await expect.poll(() => page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getPanelCreateCalls: () => object[] } }
    ).__paneTestElectronMock.getPanelCreateCalls())).toEqual([]);
  });

  test('approximates a no-default skip with an empty mocked stage and omits the launch flag', async ({ page }) => {
    await installElectronApiMock(page, {
      omitDefaultOrchestratorAgent: true,
      projectCreateLaunchResult: { status: 'skipped', reason: 'no-default' },
    });
    await openAddDialog(page);
    await expect(page.getByText(/Creating this repository will start/)).toHaveCount(0);
    await fillRepository(page);
    await page.getByRole('button', { name: 'Create' }).click();
    // The renderer mock has no main-process session-created listener, so this empty-stage
    // assertion approximates "no agent launch" rather than the real app's pre-existing shell.
    await expect(page.getByRole('button', { name: 'Open a terminal' })).toBeVisible();
    const calls = await page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getProjectCreateCalls: () => Array<{ launchDefaultAgent?: boolean }> } }
    ).__paneTestElectronMock.getProjectCreateCalls());
    expect(calls[0]).not.toHaveProperty('launchDefaultAgent');
  });

  test('does not send the launch flag from Clone from GitHub', async ({ page }) => {
    await installElectronApiMock(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'GitHub' }).click();
    await page.getByPlaceholder('https://github.com/user/repo').fill('https://github.com/example/repo');
    await page.getByRole('button', { name: 'Browse' }).click();
    await page.getByRole('button', { name: 'Clone' }).click();
    const calls = await page.evaluate(() => (
      // SAFETY: installElectronApiMock installs this test-only bridge before navigation.
      window as typeof window & { __paneTestElectronMock: { getProjectCreateCalls: () => Array<{ name?: string; path?: string; launchDefaultAgent?: boolean }> } }
    ).__paneTestElectronMock.getProjectCreateCalls());
    expect(calls[0]).not.toHaveProperty('launchDefaultAgent');
  });
});
