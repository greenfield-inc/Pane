import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 400,
  name: 'Leaderboard fixture',
  path: '/tmp/lb-fixture',
  active: true,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const leaderboardEntries = {
  windowDays: 30 as const,
  total: 3,
  entries: [
    { rank: 1, displayName: '@jdoe', verified: true, estimatedCostUsd: 1204.10, costIncomplete: false, outputTokens: 41_200_000, messageCount: 6102, topModel: 'claude-opus-4', installs: 1, updatedAtMs: Date.now() },
    { rank: 2, displayName: 'quiet-heron-91c0', verified: false, estimatedCostUsd: 688.55, costIncomplete: false, outputTokens: 22_000_000, messageCount: 3880, topModel: 'claude-opus-4', installs: 1, updatedAtMs: Date.now() },
    { rank: 3, displayName: '@testuser', verified: true, estimatedCostUsd: 312.40, costIncomplete: false, outputTokens: 14_200_000, messageCount: 18204, topModel: 'claude-sonnet-5', installs: 1, updatedAtMs: Date.now() },
  ],
  generatedAtMs: Date.now(),
};

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('leaderboard tab shows join banner and table before opt-in', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    activeProjectId: project.id,
    initialLeaderboard: leaderboardEntries,
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Usage & Limits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Usage & limits' })).toBeVisible();

  // Click the Leaderboard tab
  await page.getByRole('tab', { name: 'Leaderboard' }).click();

  // Join banner is visible
  await expect(page.getByRole('heading', { name: 'Join the leaderboard' })).toBeVisible();
  await expect(page.getByText('Pane sends')).toBeVisible();
  await expect(page.getByText('Pane never sends')).toBeVisible();

  // Table is rendered (read-only, before consent)
  await expect(page.getByText('@jdoe')).toBeVisible();
  await expect(page.getByText('quiet-heron-91c0')).toBeVisible();
  await expect(page.getByText('$1204.10')).toBeVisible();

  await page.getByRole('button', { name: '@jdoe', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (
    // SAFETY: The Electron API mock installs this test-only accessor before navigation.
    window as typeof window & {
      __paneTestElectronMock: { getOpenedExternalUrls: () => string[] };
    }
  ).__paneTestElectronMock.getOpenedExternalUrls())).toContain('https://github.com/jdoe');

  await expect(page.getByRole('button', { name: 'Follow @jdoe on GitHub' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Follow quiet-heron-91c0 on GitHub' })).toBeHidden();

  // Provider/range toggles are hidden on leaderboard tab
  await expect(page.getByRole('group', { name: 'Provider' })).toBeHidden();
  await expect(page.getByRole('group', { name: 'Time range' })).toBeHidden();

  await capture(page, testInfo, '01-leaderboard-before-join.png');
});

test('leaderboard tab shows joined banner when opted in', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    activeProjectId: project.id,
    initialLeaderboardStatus: {
      optIn: true,
      lastRank: 3,
      lastDisplayName: '@testuser',
      lastSubmittedAtMs: Date.now() - 60_000,
      doNotTrack: false,
    },
    initialLeaderboard: leaderboardEntries,
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Usage & Limits', exact: true }).click();
  await page.getByRole('tab', { name: 'Leaderboard' }).click();

  // Joined banner — sendNow auto-fires on tab visit and the mock returns rank 1
  const banner = page.getByText("You're on the leaderboard");
  await expect(banner).toBeVisible();
  await expect(page.getByText('ranked #1')).toBeVisible();

  // Send now and Leave buttons
  await expect(page.getByRole('button', { name: 'Send now' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible();

  // User's own row is highlighted with "you" label
  const userRow = page.locator('tr').filter({ hasText: 'you' });
  await expect(userRow).toBeVisible();
  await expect(userRow.getByText('@testuser')).toBeVisible();

  await capture(page, testInfo, '02-leaderboard-joined.png');
});

test('tab navigation switches between My usage and Leaderboard', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    activeProjectId: project.id,
    initialLeaderboard: leaderboardEntries,
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Usage & Limits', exact: true }).click();

  // Default is My usage tab
  const myUsageTab = page.getByRole('tab', { name: 'My usage' });
  await expect(myUsageTab).toHaveAttribute('aria-selected', 'true');

  // Switch to Leaderboard
  await page.getByRole('tab', { name: 'Leaderboard' }).click();
  await expect(page.getByRole('heading', { name: 'Join the leaderboard' })).toBeVisible();

  // Switch back to My usage
  await myUsageTab.click();
  await expect(page.getByRole('group', { name: 'Provider' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Join the leaderboard' })).toBeHidden();

  await capture(page, testInfo, '03-tab-navigation.png');
});

test('DO_NOT_TRACK disables join button', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    activeProjectId: project.id,
    initialLeaderboardStatus: {
      optIn: false,
      lastRank: null,
      lastDisplayName: null,
      lastSubmittedAtMs: null,
      doNotTrack: true,
    },
    initialLeaderboard: leaderboardEntries,
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Usage & Limits', exact: true }).click();
  await page.getByRole('tab', { name: 'Leaderboard' }).click();

  // Join button is disabled
  const joinButton = page.getByRole('button', { name: 'Join the leaderboard' });
  await expect(joinButton).toBeDisabled();

  // Warning message is visible
  await expect(page.getByText('DO_NOT_TRACK is set')).toBeVisible();

  await capture(page, testInfo, '04-do-not-track.png');
});
