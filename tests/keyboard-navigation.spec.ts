import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// Keyboard navigation across the window (P3, journeys 3 to 5): ⌘0 walks the
// sidebar, ⌘⌥+arrows cross region edges, F6 cycles, and focus shows quietly.

const now = new Date(0).toISOString();
const project = { id: 77, name: 'Nav fixture', path: '/tmp/nav-fixture', active: true, created_at: now, updated_at: now };
const pane = (id: string, name: string, displayOrder: number) => ({
  id, name, worktreePath: `/tmp/nav-fixture/${id}`, prompt: '', status: 'stopped', createdAt: now, lastActivity: now,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder,
  isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
});
const sessions = [pane('nav-a', 'auth-refactor', 0), pane('nav-b', 'billing-migration', 1)];
const terminal = (id: string, title: string, position: number, isActive = false) => ({
  id, sessionId: 'nav-a', type: 'terminal', title,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position },
});
const panels = [terminal('dock', 'Terminal', 0), terminal('alpha', 'Alpha', 1, true), terminal('beta', 'Beta', 2)];
const layout = {
  version: 1,
  focusedGroupId: 'g-left',
  root: {
    type: 'split', id: 's-root', direction: 'row', sizes: [1, 1],
    children: [
      { type: 'group', id: 'g-left', panelIds: ['alpha'], activePanelId: 'alpha' },
      { type: 'group', id: 'g-right', panelIds: ['beta'], activePanelId: 'beta' },
    ],
  },
};

async function openFixture(page: Page): Promise<void> {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: sessions, initialPanels: panels, initialLayout: layout,
    activeProjectId: project.id,
  });
  await page.addInitScript(() => localStorage.setItem('pane-detail-panel-visible', 'true'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand project Nav fixture', exact: true }).click();
  await page.getByRole('button', { name: 'auth-refactor', exact: true }).click();
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeVisible();
  // A terminal that finishes opening focuses itself; let both settle first.
  await expect(page.locator('[data-panel-group-id] .xterm-helper-textarea')).toHaveCount(2);
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
}

/** Which region and group hold keyboard focus. */
async function focusPlace(page: Page): Promise<{ region: string | null; group: string | null; label: string | null }> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      region: active?.closest('[data-focus-region]')?.getAttribute('data-focus-region') ?? null,
      group: active?.closest('[data-panel-group-id]')?.getAttribute('data-panel-group-id') ?? null,
      label: active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? null,
    };
  });
}

test('⌘0 puts the cursor on the open Pane, and the arrows walk up into the top buttons and back', async ({ page }) => {
  await openFixture(page);
  await page.locator('[data-panel-group-id="g-left"] .xterm-helper-textarea, [data-panel-group-id="g-left"]').first().click();
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar', label: 'auth-refactor' });

  // The sidebar lists billing-migration above auth-refactor.
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'billing-migration' });
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'auth-refactor' });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'Collapse project Nav fixture' });

  // ← collapses the project, → expands it again, and the cursor stays.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button', { name: 'Expand project Nav fixture', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Collapse project Nav fixture', exact: true })).toBeFocused();

  // Up past the projects into the top buttons: Loops, Pane Chat, New, Search.
  const seen: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('ArrowUp');
    seen.push((await focusPlace(page)).label ?? '');
  }
  expect(seen).toEqual(expect.arrayContaining(['Loops', 'Pane Chat', 'New', 'Search']));
  await page.keyboard.press('End');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar' });
});

test('Space opens a Pane and keeps the cursor; Enter opens it and moves into its split; Esc goes back', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'billing-migration', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'billing-migration', exact: true })).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'auth-refactor', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });

  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar' });
  await page.keyboard.press('Escape');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });
});

test('⌘⌥→ jumps from the sidebar through both splits to the right panel and back; only the active split keeps its accent', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  const strips = page.locator('.panel-group-tab-bar .panel-tab-strip');
  // With focus in the sidebar, no split's tab carries the accent.
  await expect(strips.nth(0)).toHaveClass(/panel-tab-strip-dimmed/);
  await expect(strips.nth(1)).toHaveClass(/panel-tab-strip-dimmed/);

  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main', group: 'g-left' });
  await expect(strips.nth(0)).not.toHaveClass(/panel-tab-strip-dimmed/);
  await expect(strips.nth(1)).toHaveClass(/panel-tab-strip-dimmed/);

  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main', group: 'g-right' });
  await expect(strips.nth(0)).toHaveClass(/panel-tab-strip-dimmed/);
  await expect(strips.nth(1)).not.toHaveClass(/panel-tab-strip-dimmed/);

  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'right-panel' });

  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-right' });
  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-left' });
  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar' });
});

test('F6 and ⇧F6 cycle the sidebar, the splits and the right panel', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  const order: Array<string | null> = [];
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('F6');
    const place = await focusPlace(page);
    order.push(place.group ?? place.region);
  }
  expect(order).toEqual(['g-left', 'g-right', 'right-panel', 'sidebar']);
  await page.keyboard.press('Shift+F6');
  await expect.poll(async () => (await focusPlace(page)).region).toBe('right-panel');
});
