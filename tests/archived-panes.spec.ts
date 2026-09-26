import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

interface ArchivedPane { id: string; name: string; archived: boolean }
declare global {
  interface Window {
    __archivedPaneFixture: {
      panes: ArchivedPane[];
      deletedIds: string[];
      confirmations: string[];
      archiveDuringConfirmation: boolean;
      failId?: string;
    };
  }
}
const project = { id: 384, name: 'Archive fixture', path: '/tmp/archive-fixture', active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };

async function setup(page: Page) {
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: [], activeProjectId: project.id });
  await page.goto('/');
  await page.evaluate((project) => {
    const fixture = { panes: [{ id: 'old', name: 'Old pane', archived: true }], deletedIds: [], confirmations: [], archiveDuringConfirmation: false };
    window.__archivedPaneFixture = fixture;
    window.electronAPI.sessions.getArchivedWithProjects = async () => ({ success: true, data: fixture.panes.length ? [{ ...project, sessions: structuredClone(fixture.panes) }] : [] });
    window.electronAPI.sessions.permanentDelete = async (id) => {
      const state = window.__archivedPaneFixture;
      if (id === state.failId) {
        state.panes = state.panes.filter(pane => pane.id !== id);
        return { success: false, error: 'Pane was restored' };
      }
      state.deletedIds.push(id);
      state.panes = state.panes.filter(pane => pane.id !== id);
      return { success: true };
    };
    window.electronAPI.sessions.permanentDeleteArchived = async () => {
      const state = window.__archivedPaneFixture;
      state.deletedIds.push(...state.panes.map(pane => pane.id));
      state.panes = [];
      return { success: true, data: { deletedCount: state.deletedIds.length } };
    };
    window.confirm = (message) => {
      const state = window.__archivedPaneFixture;
      state.confirmations.push(message ?? '');
      if (state.archiveDuringConfirmation) state.panes.push({ id: 'new-during-confirm', name: 'New during confirmation', archived: true });
      return true;
    };
  }, project);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('button', { name: 'Archive fixture 1', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open archived pane Old pane', exact: true })).toBeVisible();
}

test('reopening Archived reloads panes archived since the previous expansion', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.evaluate(() => window.__archivedPaneFixture.panes.push({ id: 'late', name: 'Later pane', archived: true }));
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open archived pane Later pane', exact: true })).toBeVisible();
});

for (const event of ['deleted', 'updated']) {
  test(`the expanded archive refreshes after a session ${event} event`, async ({ page }) => {
    await setup(page);
    await page.evaluate((event) => {
      const pane = { id: 'late', name: 'Later pane', archived: true };
      window.__archivedPaneFixture.panes.push(pane);
      // SAFETY: installElectronApiMock defines this event bridge before navigation.
      const mock = (window as Window & { __paneTestElectronMock: {
        emitSessionDeleted: (id: string) => void;
        emitSessionUpdated: (pane: ArchivedPane) => void;
      } }).__paneTestElectronMock;
      if (event === 'deleted') mock.emitSessionDeleted(pane.id);
      else mock.emitSessionUpdated(pane);
    }, event);
    await expect(page.getByRole('button', { name: 'Open archived pane Later pane', exact: true })).toBeVisible();
  });
}

test('delete-all confirms a fresh count and deletes only the confirmed panes', async ({ page }, testInfo) => {
  await setup(page);
  await page.evaluate(() => {
    window.__archivedPaneFixture.panes.push({ id: 'before-confirm', name: 'Before confirmation', archived: true });
    window.__archivedPaneFixture.archiveDuringConfirmation = true;
  });
  await page.getByRole('button', { name: 'Permanently delete all archived panes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__archivedPaneFixture.confirmations)).toEqual([
    'Permanently delete all 2 archived panes?\n\nThis removes them from Pane history and cannot be undone.',
  ]);
  expect(await page.evaluate(() => window.__archivedPaneFixture.deletedIds)).toEqual(['old', 'before-confirm']);
  await expect(page.getByRole('button', { name: 'Open archived pane New during confirmation', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('preserved-unconfirmed-pane.png') });
});


test('a pane restored during deletion is preserved and the archive refreshes with an error', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { window.__archivedPaneFixture.failId = 'old'; });
  await page.getByRole('button', { name: 'Permanently delete all archived panes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Pane was restored' })).toBeVisible();
  await expect(page.getByText('No archived panes', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__archivedPaneFixture.deletedIds)).toEqual([]);
});
