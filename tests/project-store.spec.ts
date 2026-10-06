import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const projects = [
  { id: 11, name: 'Alpha', path: '/tmp/alpha', active: true, displayOrder: 0, created_at: '', updated_at: '' },
  { id: 22, name: 'Beta', path: '/tmp/beta', active: false, displayOrder: 1, created_at: '', updated_at: '' },
];

declare global {
  interface Window {
    __projectReorder: {
      payloads: Array<Array<{ id: number; displayOrder: number }>>;
      finish?: (success: boolean) => void;
    };
  }
}

test('project reorder is shared with Home immediately and rolls back a rejected save', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { initialProjects: projects, initialSessions: [], activeProjectId: 11 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Project', exact: true }).waitFor();
  await page.evaluate(() => {
    window.__projectReorder = { payloads: [] };
    window.electronAPI.projects.reorder = async payload => {
      window.__projectReorder.payloads.push(payload);
      return new Promise(resolve => {
        window.__projectReorder.finish = success => resolve({ success, error: success ? undefined : 'Repository order could not be saved.' });
      });
    };
  });
  const rows = page.locator('[draggable="true"]').filter({ has: page.locator('[aria-controls^="project-sessions-"]') });
  await rows.filter({ hasText: 'Alpha' }).dragTo(rows.filter({ hasText: 'Beta' }));
  await expect.poll(() => page.evaluate(() => window.__projectReorder.payloads)).toEqual([
    [{ id: 22, displayOrder: 0 }, { id: 11, displayOrder: 1 }],
  ]);
  await expect(rows.first()).toContainText('Beta');
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  await expect(page.getByRole('menuitem').first()).toContainText('beta');
  await page.screenshot({ path: testInfo.outputPath('shared-pending-order.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__projectReorder.finish?.(false));
  await expect(rows.first()).toContainText('Alpha');
  await expect(page.getByRole('alert').filter({ hasText: 'Repository order could not be saved.' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  await expect(page.getByRole('menuitem').first()).toContainText('alpha');
  await page.screenshot({ path: testInfo.outputPath('shared-rollback.png') });
});

test('project IPC updates reach Sidebar and Home without fetching another list', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { initialProjects: projects, initialSessions: [], activeProjectId: 11 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Project', exact: true }).waitFor();
  await page.getByText('Alpha', { exact: true }).waitFor();
  await page.evaluate(project => {
    window.electronAPI.projects.getAll = async () => { throw new Error('Unexpected project reload'); };
    // SAFETY: installElectronApiMock exposes the host event bridge for browser journeys.
    const mock = (window as Window & { __paneTestElectronMock: { emitProjectUpdated: (updated: typeof project) => void } }).__paneTestElectronMock;
    mock.emitProjectUpdated({ ...project, name: 'Renamed Alpha' });
  }, projects[0]);
  await expect(page.getByText('Renamed Alpha', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Project', exact: true }).click();
  await expect(page.getByRole('menuitem').first()).toContainText('Renamed Alpha');
  await expect(page.getByRole('alert').filter({ hasText: 'Unexpected project reload' })).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shared-project-update.png') });
});
