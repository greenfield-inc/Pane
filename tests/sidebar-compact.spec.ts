import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

const projects = [
  {
    id: 1,
    name: 'Alpha',
    path: '/tmp/alpha',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    name: 'Beta',
    path: '/tmp/beta',
    active: false,
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
];

function session(
  id: string,
  name: string,
  projectId: number,
  overrides: JsonObject = {},
) {
  return {
    id,
    name,
    projectId,
    worktreePath: `/tmp/${id}`,
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
    ...overrides,
  };
}

async function collapseSidebar(page: Page) {
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  await expect(collapse).toBeVisible({ timeout: 10_000 });
  await collapse.click();
  await expect(page.getByRole('navigation', { name: 'Compact sidebar' })).toBeVisible();
}

test.describe('compact sidebar', () => {
  test('collapses repositories from the full sidebar using the shared section state', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const pinnedToggle = page.getByRole('button', { name: 'Pinned', exact: true });
    const repositoriesToggle = page.getByRole('button', { name: 'Repositories', exact: true });
    await expect(pinnedToggle).toBeVisible();
    await expect(repositoriesToggle).toBeVisible();
    await expect(page.getByText('Alpha', { exact: true })).toBeVisible();

    const [pinnedBox, repositoriesBox] = await Promise.all([
      pinnedToggle.boundingBox(),
      repositoriesToggle.boundingBox(),
    ]);
    expect(repositoriesBox?.height).toBe(pinnedBox?.height);

    await repositoriesToggle.click();
    await expect(page.getByText('Alpha', { exact: true })).toHaveCount(0);

    await collapseSidebar(page);
    await expect(page.getByTestId('compact-repositories-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('compact-repositories-toggle').click();
    await expect(page.getByTestId('compact-repository-1')).toBeVisible();
  });

  test('shows the full pane title when hovering a long sidebar label', async ({ page }) => {
    const longPaneTitle = 'TIP416A · Show the complete descriptive pane title in the sidebar hover popover';

    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [session('pane416--show-full-pane-title-in-sidebar-hover', longPaneTitle, 1)],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: longPaneTitle, exact: true }).hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByText(longPaneTitle, { exact: true })).toBeVisible();
    await expect(tooltip).toContainText('pane416--show-full-pane-title-in-sidebar-hover');

    await collapseSidebar(page);
    await page.getByTestId('compact-repository-pane-pane416--show-full-pane-title-in-sidebar-hover').hover();
    const compactTooltip = page.getByRole('tooltip');
    await expect(compactTooltip.getByText(longPaneTitle, { exact: true })).toHaveCount(1);
    await expect(compactTooltip).toContainText('pane416--show-full-pane-title-in-sidebar-hover');
  });

  test('keeps the hover background on the active pane in both sidebar modes', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const fullSidebarPane = page.getByRole('button', { name: 'Regular work', exact: true });
    await fullSidebarPane.click();
    await expect(fullSidebarPane).toHaveAttribute('aria-current', 'page');
    await expect(fullSidebarPane.locator('..')).toHaveClass(/bg-surface-selected/);
    await fullSidebarPane.evaluate(element => element.blur());
    await page.mouse.move(640, 360);
    await page.screenshot({
      path: 'test-results/sidebar-active-pane-full.png',
      clip: { x: 0, y: 0, width: 340, height: 720 },
    });

    await collapseSidebar(page);
    const compactSidebarPane = page.getByTestId('compact-repository-pane-regular');
    await expect(compactSidebarPane).toHaveClass(/bg-surface-selected/);
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/sidebar-active-pane-compact.png',
      clip: { x: 0, y: 0, width: 180, height: 720 },
    });
  });

  test('offers archive and pin actions when a compact pane is right-clicked', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await collapseSidebar(page);

    const regularPane = page.getByTestId('compact-repository-pane-regular');
    await regularPane.click({ button: 'right' });
    let menu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    expect((await menu.boundingBox())?.width).toBeLessThanOrEqual(230);
    await expect(menu.getByRole('menuitem').nth(0)).toHaveText('Pin');
    await expect(menu.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Archive' }).click();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & {
        __paneTestElectronMock: { getSessionDeleteCalls: () => string[] };
      }
    ).__paneTestElectronMock.getSessionDeleteCalls())).toEqual(['regular']);

    await regularPane.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Pane actions for Regular work' });
    await menu.getByRole('menuitem', { name: 'Pin', exact: true }).click();

    const pinnedPane = page.getByTestId('compact-pinned-pane-pinned');
    await pinnedPane.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Pane actions for Pinned work' });
    await expect(menu.getByRole('menuitem').nth(0)).toHaveText('Unpin');
    await expect(menu.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Unpin', exact: true }).click();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & {
        __paneTestElectronMock: { getSessionFavoriteToggleCalls: () => string[] };
      }
    ).__paneTestElectronMock.getSessionFavoriteToggleCalls())).toEqual(['regular', 'pinned']);
  });

  test('keeps the destructive menu item readable under the cursor', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [session('regular', 'Regular work', 1)],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await collapseSidebar(page);

    await page.getByTestId('compact-repository-pane-regular').click({ button: 'right' });
    const archive = page
      .getByRole('menu', { name: 'Pane actions for Regular work' })
      .getByRole('menuitem', { name: 'Archive' });

    // The menu opens under the cursor, so the item is hovered from the first frame:
    // its icon and label have to survive that state.
    await expect(archive).toHaveText('Archive');
    await expect(archive.locator('svg')).toBeVisible();
    await archive.hover();

    const painted = () => archive.evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, color: style.color };
    });

    // Wait for the hover plate to finish transitioning in, then require the label
    // to still contrast with it: painting the destructive red as the background
    // swallowed the red text and left a blank slab.
    await expect
      .poll(async () => (await painted()).background)
      .not.toBe('rgba(0, 0, 0, 0)');
    const { background, color } = await painted();
    expect(background).not.toBe(color);
  });

  test('keeps the pane tooltip reachable across its whole height', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [session('regular', 'Regular work', 1, {
        gitStatus: {
          state: 'ahead',
          ahead: 2,
          prNumber: 474,
          prState: 'OPEN',
          prTitle: 'Compact sidebar nits',
          commitAdditions: 40,
          commitDeletions: 12,
          commitFilesChanged: 3,
        },
      })],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await collapseSidebar(page);

    await page.getByTestId('compact-repository-pane-regular').hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible({ timeout: 10_000 });

    const box = await tooltip.boundingBox();
    if (!box) throw new Error('tooltip has no box');

    // Travel to the tooltip's top edge, then its bottom edge — both used to sit
    // outside the hover region and dismissed it on the way.
    await page.mouse.move(box.x + box.width / 2, box.y + 4);
    await expect(tooltip).toBeVisible();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
    await expect(tooltip).toBeVisible();
    // Content that lives at the bottom of the tooltip, the part that used to be
    // unreachable: the PR state line.
    await expect(tooltip).toContainText('Open');

    // Leaving for good still dismisses it.
    await page.mouse.move(box.x + box.width + 200, box.y + box.height + 200);
    await expect(tooltip).toBeHidden({ timeout: 5_000 });
  });

  test('marks draft pull requests with the draft PR icon', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('draft', 'Draft work', 1, {
          gitStatus: { state: 'ahead', ahead: 1, prNumber: 501, prState: 'OPEN', prIsDraft: true },
        }),
        session('ready', 'Ready work', 1, {
          gitStatus: { state: 'ahead', ahead: 1, prNumber: 502, prState: 'OPEN', prIsDraft: false },
        }),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // The icon renders beside the row's button, so scope to the innermost row container.
    const row = (name: string) => page.locator('div')
      .filter({ has: page.getByRole('button', { name, exact: true }) })
      .last();
    const draftRow = row('Draft work');
    const readyRow = row('Ready work');
    await expect(draftRow.locator('svg.lucide-git-pull-request-draft')).toHaveCount(1);
    await expect(readyRow.locator('svg.lucide-git-pull-request-draft')).toHaveCount(0);
    await expect(readyRow.locator('svg.lucide-git-pull-request')).toHaveCount(1);
  });

  test('mirrors an expanded pinned section and collapsed repositories section', async ({ page }) => {
    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: true,
        repositoriesSectionExpanded: false,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Repositories', exact: true })).toBeVisible();
    await expect(page.getByText('Alpha', { exact: true })).toHaveCount(0);
    await collapseSidebar(page);

    await expect(page.getByTestId('compact-pinned-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('compact-pinned-pane-pinned')).toBeVisible();
    await expect(page.getByTestId('compact-pinned-pane-placeholder-pinned')).toBeVisible();
    await expect(page.getByTestId('compact-repositories-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('compact-repository-1')).toHaveCount(0);
    await expect(page.getByTestId('compact-repository-pane-regular')).toHaveCount(0);
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/compact-sidebar-pinned-only.png',
      clip: { x: 0, y: 0, width: 260, height: 720 },
    });

    const paneChat = page.getByTestId('compact-pane-chat');
    await paneChat.click();
    await expect(page.getByRole('heading', { name: 'Pane Chat' })).toBeVisible();
    const activePaneChatSize = await paneChat.boundingBox();
    expect(activePaneChatSize?.width).toBe(36);
    expect(activePaneChatSize?.height).toBe(36);
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/compact-sidebar-pane-chat-active.png',
      clip: { x: 0, y: 0, width: 360, height: 720 },
    });
  });

  test('uses repository expansion, shared filtering, and stable control sizing', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    const extraSessions = Array.from({ length: 8 }, (_, index) =>
      session(`extra-${index}`, `Extra ${index}`, 1, {
        createdAt: `2026-01-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`,
      }));

    await installElectronApiMock(page, {
      initialConfig: { theme: 'night-owl' },
      initialProjects: projects,
      initialSessions: [
        session('pinned', 'Pinned work', 1, {
          isFavorite: true,
          favoritePinnedAt: '2026-01-03T00:00:00.000Z',
        }),
        session('regular', 'Regular work', 1),
        session('beta', 'Beta work', 2),
        session('hidden', 'Hidden work', 1, { isHidden: true }),
        ...extraSessions,
      ],
      initialUiState: {
        expandedProjects: [1],
        pinnedSectionExpanded: false,
        repositoriesSectionExpanded: true,
      },
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await collapseSidebar(page);

    await expect(page.getByTestId('compact-pinned-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('compact-pinned-pane-pinned')).toHaveCount(0);
    await expect(page.getByTestId('compact-repository-1')).toBeVisible();
    await expect(page.getByTestId('compact-repository-pane-pinned')).toBeVisible();
    await expect(page.getByTestId('compact-repository-pane-regular')).toBeVisible();
    await expect(page.getByTestId('compact-repository-pane-beta')).toHaveCount(0);
    await expect(page.getByTestId('compact-repository-pane-hidden')).toHaveCount(0);

    await page.getByTestId('compact-repositories-toggle').click();
    await expect(page.getByTestId('compact-repositories-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('compact-repository-1')).toHaveCount(0);

    await page.getByTestId('compact-repositories-toggle').click();
    await page.getByTestId('compact-pinned-toggle').click();
    await expect(page.getByTestId('compact-pinned-pane-pinned')).toBeVisible();

    const itemSizes = await page.locator('[data-compact-rail-item]').evaluateAll(elements =>
      elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }));
    expect(itemSizes.length).toBeGreaterThan(10);
    expect(itemSizes.every(({ width, height }) => width === 36 && height === 36)).toBe(true);

    const paneChatSize = await page.getByTestId('compact-pane-chat').boundingBox();
    expect(paneChatSize?.width).toBe(36);
    expect(paneChatSize?.height).toBe(36);
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await page.getByTestId('compact-repository-1').scrollIntoViewIfNeeded();
    await page.mouse.move(320, 180);
    await page.screenshot({
      path: 'test-results/compact-sidebar-short-repositories.png',
      clip: { x: 0, y: 0, width: 180, height: 360 },
    });
  });
});
