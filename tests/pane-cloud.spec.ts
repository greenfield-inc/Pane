import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { dismissStartupDialogs, installSessionsFixture } from './orchestrationSessionsFixture';
import type { MachineConnectionsEvent } from '../shared/types/machineConnections';
import type { OrchestrationSessionCreateInput } from '../shared/types/orchestrationSession';
import type { PaneCloudSnapshot } from '../shared/types/paneCloud';

type MockWindow = typeof window & {
  __paneTestElectronMock: {
    setPaneCloud(parts: Partial<PaneCloudSnapshot>): void;
    getPaneCloudCreates(): OrchestrationSessionCreateInput[];
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
    usage: { plan: 'free', resetsAt: '2026-12-01T00:00:00.000Z', agentHoursUsed: 12, agentHoursLimit: 300, awakeNow: 5, awakeLimit: 5, members: [] },
  });
  await dialog.getByTestId('where-it-runs-cloud').click();
  await expect(dialog.getByText('You have 5 of 5 Sessions awake. Stop one to create another.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create on Pane Cloud', exact: true })).toBeDisabled();
});
