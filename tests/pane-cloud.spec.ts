import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { dismissStartupDialogs, installSessionsFixture, sessionFixture } from './orchestrationSessionsFixture';
import type { MachineConnectionsEvent } from '../shared/types/machineConnections';
import type { OrchestrationSessionCreateInput } from '../shared/types/orchestrationSession';
import type { PaneCloudSnapshot } from '../shared/types/paneCloud';

type MockWindow = typeof window & {
  __paneTestElectronMock: {
    setPaneCloud(parts: Partial<PaneCloudSnapshot>): void;
    getPaneCloudCreates(): OrchestrationSessionCreateInput[];
    getPaneCloudCalls(): Array<{ action: string; vmId: string }>;
    emitMachineEvent(event: MachineConnectionsEvent): void;
  };
};

const INSPECTION = 'During the beta, automated checks can inspect cloud machines to stop abuse. Staff look only at flagged accounts, and every look is logged.';

async function openCreateSession(page: Page, cloud: Partial<PaneCloudSnapshot> = {}) {
  await installSessionsFixture(page, [], [], { initialConfig: { appearanceMode: 'fixed', theme: 'dark' } });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    const mock = (window as MockWindow).__paneTestElectronMock;
    mock.setPaneCloud(parts);
    mock.emitMachineEvent({ type: 'machines', machines: [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
      { id: 'studio', label: 'mac-studio', kind: 'remote', status: 'online', offlineSince: null },
      { id: 'laptop', label: 'old-laptop', kind: 'remote', status: 'offline', offlineSince: '2026-11-20T00:00:00.000Z' },
    ] });
  }, cloud);
  await gotoApp(page);
  await dismissStartupDialogs(page);
  await page.getByTestId('new-orchestration-session').click();
  const dialog = page.getByRole('dialog', { name: 'Create Session', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('creates a Session on Pane Cloud from Where it runs', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1100 });
  const dialog = await openCreateSession(page);
  await expect(dialog.getByRole('radio', { name: 'mac-studio', exact: true })).toBeAttached();
  await expect(dialog.getByRole('radio', { name: 'old-laptop', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create Session', exact: true })).toBeVisible();

  await dialog.getByLabel('Session name (optional)', { exact: true }).fill('Docs site migration');
  await dialog.getByTestId('where-it-runs-cloud').click();
  await expect(dialog.getByRole('radio', { name: 'Pane Cloud', exact: true })).toBeChecked();
  await expect(dialog.getByText(INSPECTION, { exact: true })).toBeVisible();
  const submit = dialog.getByRole('button', { name: 'Create on Pane Cloud', exact: true });
  await expect(submit).toBeEnabled();
  await dialog.screenshot({ path: `${process.env.PANE_SCRATCH_DIR ?? 'tmp'}/screens/frame-B-built.png` });

  await submit.click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getPaneCloudCreates())).toEqual([
    expect.objectContaining({ name: 'Docs site migration', nameFromFirstMessage: false, agent: 'claude' }),
  ]);
  await expect(dialog).toBeHidden();
});

test('Pane Cloud at the awake limit says so and cannot create', async ({ page }) => {
  const dialog = await openCreateSession(page, {
    usage: { plan: 'free', planAgentHours: 300, planAwakeLimit: 5, resetsAt: '2026-12-01T00:00:00.000Z', agentHoursUsed: 12, agentHoursLimit: 300, awakeNow: 5, awakeLimit: 5, members: [] },
  });
  await dialog.getByTestId('where-it-runs-cloud').click();
  await expect(dialog.getByText('You have 5 of 5 Sessions awake. Stop one to create another.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create on Pane Cloud', exact: true })).toBeDisabled();
});

const CLOUD_SESSIONS: Partial<PaneCloudSnapshot> = {
  sessions: [
    { vmId: 'vm-1', name: 'Docs site migration', awake: true, underReview: false, machineId: 'cloud-1', paneVersion: '2.4.249', createdAt: '2026-11-20T10:00:00.000Z' },
    { vmId: 'vm-2', name: 'Pricing page copy', awake: false, underReview: false, machineId: 'cloud-2', paneVersion: '2.4.249', createdAt: '2026-11-19T10:00:00.000Z' },
  ],
  usage: {
    plan: 'free', planAgentHours: 300, planAwakeLimit: 5, resetsAt: '2026-12-01T00:00:00.000Z', agentHoursUsed: 131.6, agentHoursLimit: 300, awakeNow: 1, awakeLimit: 5,
    members: [{ accountId: 'acct-1', name: 'Maya', you: true, agentHours: 131.6, awakeNow: 1, awakeLimit: 5 }],
  },
};

test('cloud Sessions sit in the Sessions list like any other, with Stop and Start', async ({ page }) => {
  await installSessionsFixture(page, [sessionFixture('local-1', 'Checkout redesign', 'Redesign the checkout', '', '2026-11-20T09:00:00.000Z')], [], {
    initialConfig: { appearanceMode: 'fixed', theme: 'dark' },
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'cloud-1', label: 'Docs site migration', kind: 'remote', status: 'online', offlineSince: null },
      ],
      reads: {
        'cloud-1': {
          'orchestration-sessions:list': { success: true, data: { sessions: [{ id: 'legacy-pane-chat', name: 'Onboarding', archived: false }, { id: 'c-1', name: 'Docs site migration', archived: false }] } },
          'orchestration-sessions:activity-list': { success: true, data: [{ sessionId: 'c-1', state: 'working', workingPanes: 2 }] },
        },
      },
    },
  });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(parts);
  }, CLOUD_SESSIONS);
  await gotoApp(page);
  await dismissStartupDialogs(page);

  const list = page.locator('#orchestration-sessions-list');
  const working = list.getByRole('button', { name: 'Open Session Docs site migration', exact: true });
  await expect(working).toBeVisible();
  await expect(working.getByTestId('session-activity-icon')).toHaveAttribute('data-state', 'working');
  await expect(working).toContainText('2 working');
  const stopped = list.getByRole('button', { name: 'Open Session Pricing page copy', exact: true });
  await expect(stopped).toBeVisible();
  await page.getByTestId('sidebar').first().screenshot({ path: `${process.env.PANE_SCRATCH_DIR ?? 'tmp'}/screens/frame-C-built.png` });

  // The VM's own Onboarding Session is not one the person made, so it gets no row.
  await expect(list.getByRole('button', { name: 'Open Session Onboarding', exact: true })).toHaveCount(0);
  await working.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Docs site migration?' });
  await expect(confirm).toContainText('every Session on it');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();

  await working.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stop', exact: true }).click();
  await stopped.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Start', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    window as MockWindow
  ).__paneTestElectronMock.getPaneCloudCalls())).toEqual([{ action: 'stop', vmId: 'vm-1' }, { action: 'start', vmId: 'vm-2' }]);
});

test('Usage & Limits shows Pane Cloud hours as a plain number of the plan, with no Upgrade', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installSessionsFixture(page, [], [], { initialConfig: { appearanceMode: 'fixed', theme: 'dark' } });
  await page.addInitScript((parts) => {
    // SAFETY: installElectronApiMock's init script, registered first, defines this test-only API.
    (window as MockWindow).__paneTestElectronMock.setPaneCloud(parts);
  }, CLOUD_SESSIONS);
  await gotoApp(page);
  await dismissStartupDialogs(page);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Usage & Limits', exact: true }).click();

  const cloud = page.getByTestId('pane-cloud-usage');
  await expect(cloud.getByText('Free · 300 agent-hours a month, 5 Sessions awake at once.', { exact: true })).toBeVisible();
  await expect(cloud.getByText('131 of 300', { exact: true })).toBeVisible();
  await expect(cloud.getByText('The month starts again on December 1.', { exact: true })).toBeVisible();
  await expect(cloud.getByText('1 of 5', { exact: true })).toBeVisible();
  await expect(cloud.getByText('An hour in a Session running at 16 GB counts as 2 hours.', { exact: true })).toBeVisible();
  await expect(cloud.getByRole('button', { name: /upgrade/i })).toHaveCount(0);
  await cloud.screenshot({ path: `${process.env.PANE_SCRATCH_DIR ?? 'tmp'}/screens/frame-P-built.png` });
});
