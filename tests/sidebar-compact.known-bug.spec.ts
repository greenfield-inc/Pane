import { expect, test } from '@playwright/test';
import { installElectronApiMock, gotoApp } from './electronApiMock';
import { collapseSidebar, projects, session } from './sidebarCompactFixture';

// Out of CI (NOT_IN_CI in scripts/ci-test-inventory.mjs) until #1561 is fixed: in a
// short window the compact rail's pinned toggle sits under the sticky Projects header.
// Moved unchanged from sidebar-compact.spec.ts (D-40), so the rest of that file runs in CI.

test.describe('compact sidebar', () => {
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

    await gotoApp(page);
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
