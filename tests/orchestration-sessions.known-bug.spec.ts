import { expect, test } from '@playwright/test';
import { gotoApp } from './electronApiMock';
import { dismissStartupDialogs, dragSessionOntoTile, installSessionsFixture, layoutBox, sessionFixture } from './orchestrationSessionsFixture';

// Out of CI (scripts/ci-test-inventory.mjs NOT_IN_CI) until #1560 is fixed: closing
// an unfocused Session tile only focuses it. Moved unchanged from
// orchestration-sessions.spec.ts (D-40), so the rest of that file runs in CI.

test('a Session dropped on another tiles beside it, survives a reload, and closes back to one', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installSessionsFixture(page, [
    sessionFixture('alpha', 'Alpha', 'Alpha goal.', 'Alpha context.', '2026-09-16T12:00:00.000Z'),
    sessionFixture('beta', 'Beta', 'Beta goal.', 'Beta context.', '2026-09-16T12:01:00.000Z'),
  ]);
  await gotoApp(page);
  await dismissStartupDialogs(page);

  await page.getByTestId('orchestration-session-alpha').click();
  const tiles = page.getByTestId('session-tile-header');
  await expect(page.getByRole('heading', { level: 1, name: 'Alpha', exact: true })).toBeAttached();

  // Drop Beta on the right quarter of Alpha's tile: an edge drop splits.
  const stage = await layoutBox(page.getByTestId('session-tile-layout'));
  await dragSessionOntoTile(page, 'orchestration-session-beta', {
    x: stage.x + stage.width - 20,
    y: stage.y + stage.height / 2,
  });

  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0)).toBeVisible();
  await expect(tiles.nth(1)).toBeVisible();
  await expect(tiles.nth(0)).toContainText('Alpha');
  await expect(tiles.nth(1)).toContainText('Beta');
  // Both tiles stay mounted and live; neither is a placeholder for the other.
  await expect(page.locator('[data-session-content-id]')).toHaveCount(2);

  // The layout is remembered per host, so reopening Sessions brings it back
  // whole rather than dropping to the one Session that was selected. Writes are
  // debounced like every other layout write, so wait for it to land.
  await expect.poll(() => page.evaluate(
    () => window.localStorage.getItem('__pane_test_session_workspace_layouts__') !== null,
  )).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissStartupDialogs(page);
  await page.getByTestId('orchestration-session-alpha').click();
  await expect(tiles).toHaveCount(2, { timeout: 10_000 });
  await expect(tiles.nth(0)).toContainText('Alpha');
  await expect(tiles.nth(1)).toContainText('Beta');

  // Closing a tile stops tiling that Session without touching the Session.
  await page.getByRole('button', { name: 'Stop tiling Beta', exact: true }).click();
  await expect(page.locator('[data-session-content-id]')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Alpha', exact: true })).toBeAttached();
  await expect(page.getByTestId('orchestration-session-beta')).toBeVisible();
});
