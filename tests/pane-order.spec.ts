import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { JsonValue } from '../shared/validation/boundaryDecoder';

type PaneOrderMock = {
  getPaneOrderCalls: () => JsonValue[];
  emitSessionUpdated: (session: Record<string, JsonValue>) => void;
};

const mock = (page: Page) => page.evaluateHandle(() => {
  // SAFETY: installElectronApiMock defines this test-only object before the app loads.
  return (window as typeof window & { __paneTestElectronMock: PaneOrderMock }).__paneTestElectronMock;
});

const now = '2026-10-30T08:00:00.000Z';
const project = { id: 7, name: 'acme-web', path: '/code/acme-web', active: true, created_at: now, updated_at: now };
// Created a minute apart: c is the newest. displayOrder rises with creation, as on a real host.
const pane = (id: string, minute: number, displayOrder: number) => ({
  id, name: id, projectId: project.id, worktreePath: `/code/acme-web/${id}`, prompt: '', status: 'stopped',
  createdAt: `2026-10-30T09:0${minute}:00.000Z`, lastActivity: now, displayOrder,
  output: [], jsonMessages: [], toolType: 'none', archived: false, isRunning: false,
});

async function openSidebar(page: Page, options: { paneOrderUnsupported?: boolean } = {}) {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [pane('add-dark-mode', 1, 0), pane('fix-checkout-race', 2, 1), pane('load-test', 3, 2)],
    initialUiState: { expandedProjects: [project.id] },
    paneOrderUnsupported: options.paneOrderUnsupported,
  });
  await page.goto('/');
  await expect(paneRows(page)).toHaveCount(3);
}

const paneRows = (page: Page) => page.locator(`#project-sessions-${project.id} [data-row-key]`);
const rowFor = (page: Page, name: string) => page.locator(`#project-sessions-${project.id} [data-row-key="${name}"]`);

test('Panes list newest first, and a drag or Alt+Up/Down saves the order on the host', async ({ page }, testInfo) => {
  await openSidebar(page);
  await expect(paneRows(page)).toHaveText([/load-test/, /fix-checkout-race/, /add-dark-mode/]);

  await rowFor(page, 'add-dark-mode').dragTo(rowFor(page, 'load-test'), { targetPosition: { x: 40, y: 2 } });
  await expect(paneRows(page)).toHaveText([/add-dark-mode/, /load-test/, /fix-checkout-race/]);

  await page.getByRole('button', { name: 'load-test', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(paneRows(page)).toHaveText([/add-dark-mode/, /fix-checkout-race/, /load-test/]);
  await expect(page.getByRole('button', { name: 'load-test', exact: true })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Moved load-test to position 3 of 3' })).toBeAttached();

  expect(await (await mock(page)).evaluate(api => api.getPaneOrderCalls())).toEqual([
    { reorderInProject: { projectId: 7, paneIds: ['add-dark-mode', 'load-test', 'fix-checkout-race'] } },
    { reorderInProject: { projectId: 7, paneIds: ['add-dark-mode', 'fix-checkout-race', 'load-test'] } },
  ]);
  await page.screenshot({ path: testInfo.outputPath('pane-order-dragged.png') });
});

test('agent activity and a renamed Pane move no Pane', async ({ page }) => {
  await openSidebar(page);
  const rowKeys = () => paneRows(page).evaluateAll(rows => rows.map(row => row.getAttribute('data-row-key')));
  expect(await rowKeys()).toEqual(['load-test', 'fix-checkout-race', 'add-dark-mode']);
  // The oldest Pane is renamed and turns active: its lastActivity is now the newest.
  await (await mock(page)).evaluate(api => api.emitSessionUpdated({
    id: 'add-dark-mode', name: 'dark-mode-v2', projectId: 7, worktreePath: '/code/acme-web/add-dark-mode', prompt: '', status: 'running',
    createdAt: '2026-10-30T09:01:00.000Z', lastActivity: '2026-10-30T11:00:00.000Z', displayOrder: 0, output: [], jsonMessages: [],
    toolType: 'none', archived: false, isRunning: true,
  }));

  // The update landed, and the rows kept their places.
  await expect(rowFor(page, 'add-dark-mode')).toContainText('dark-mode-v2');
  expect(await rowKeys()).toEqual(['load-test', 'fix-checkout-race', 'add-dark-mode']);
});

test('Sort re-sorts once and dragging afterwards still holds', async ({ page }, testInfo) => {
  await openSidebar(page);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: /Sort: Newest first.*Current/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pane-order-sort-menu.png') });
  await page.getByRole('menuitem', { name: /Sort: Oldest first/ }).click();
  await expect(paneRows(page)).toHaveText([/add-dark-mode/, /fix-checkout-race/, /load-test/]);

  await page.getByRole('button', { name: 'fix-checkout-race', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(paneRows(page)).toHaveText([/fix-checkout-race/, /add-dark-mode/, /load-test/]);

  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitem', { name: /Sort: Oldest first.*Current/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /Sort: Newest first/ }).click();
  await expect(paneRows(page)).toHaveText([/load-test/, /fix-checkout-race/, /add-dark-mode/]);
  expect(await (await mock(page)).evaluate(api => api.getPaneOrderCalls())).toEqual([
    { sortPanes: 'oldest' },
    { reorderInProject: { projectId: 7, paneIds: ['fix-checkout-race', 'add-dark-mode', 'load-test'] } },
    { sortPanes: 'newest' },
  ]);
});

test('a host on an older Pane puts the list back and says to update Pane there', async ({ page }, testInfo) => {
  await openSidebar(page, { paneOrderUnsupported: true });
  await page.getByRole('button', { name: 'add-dark-mode', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');

  await expect(page.getByText('The Pane order was not saved')).toBeVisible();
  await expect(page.getByText(/Update Pane on build-box/)).toBeVisible();
  await expect(paneRows(page)).toHaveText([/load-test/, /fix-checkout-race/, /add-dark-mode/]);
  await page.screenshot({ path: testInfo.outputPath('pane-order-older-host.png') });
});
