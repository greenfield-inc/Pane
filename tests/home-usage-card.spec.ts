import { test, expect, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

declare global {
  interface Window {
    __paneTestElectronMock: { getInvokeCalls(channel: string): Array<{ args: unknown[] }> };
  }
}

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, messageCount: 0, estimatedCostUsd: 0, costIncomplete: false, cacheSavingsUsd: 0 };
const finished = { lastScanStartedMs: 1, lastScanFinishedMs: 2, filesTracked: 3, eventsIndexed: 2, missingRoots: [], scanning: false, filesScanned: 0, filesTotal: 0, lastError: null };

function report(overrides: JsonObject): JsonObject {
  return {
    totals: zero, series: [], byModel: [], byProject: [],
    byPane: { panes: [], unattributed: { ...zero, uncachedCostUsd: 0, uncachedInputTokens: 0, cacheHitRate: 0, byModel: [] } },
    rateLimits: [], index: finished, pricingAsOf: '2026-11-01',
    ...overrides,
  };
}

const POPULATED = report({
  totals: { ...zero, totalTokens: 2_000_000, messageCount: 42, estimatedCostUsd: 12.5 },
  byModel: [{ ...zero, totalTokens: 2_000_000, model: 'claude-opus-4-1', provider: 'claude' }],
  byProject: [{ ...zero, totalTokens: 2_000_000, path: '/code/acme-web', label: 'acme-web' }],
});

async function openHome(page: Page, usage: JsonObject) {
  await installElectronApiMock(page, { initialProjects: [], initialSessions: [], initialPreferences: { hide_discord: 'true' }, initialUsageReport: usage });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const name of ['No thanks', 'Get Started', 'Skip', 'Skip for now']) {
    const button = page.getByRole('dialog').getByRole('button', { name, exact: true });
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) await button.click();
  }
  const card = page.getByTestId('home-usage-card');
  await expect(card).toBeVisible();
  return card;
}

const usageCalls = (page: Page) => page.evaluate(() => ({
  report: window.__paneTestElectronMock.getInvokeCalls('usage:get-report').length,
  status: window.__paneTestElectronMock.getInvokeCalls('usage:get-status').length,
}));

test('shows the usage numbers, and Join the leaderboard opens its tab', async ({ page }) => {
  const card = await openHome(page, POPULATED);
  await expect(card).toContainText('2.0M');
  await expect(card).toContainText('$12.50 est. at API rates · 42 messages');
  await expect(card).toContainText('acme-web');
  await card.getByRole('button', { name: 'Join the leaderboard' }).click();
  await expect(page.getByRole('tab', { name: 'Leaderboard' })).toHaveAttribute('aria-selected', 'true');
});

test('a pass that ended with an error shows the read failure and stops asking', async ({ page }) => {
  const card = await openHome(page, report({ index: { ...finished, lastScanFinishedMs: null, lastError: 'EACCES: permission denied' } }));
  await expect(card).toContainText("Pane couldn't read your agent history");
  const first = await usageCalls(page);
  await page.waitForTimeout(5000);
  expect(await usageCalls(page)).toEqual(first);
  expect(first).toEqual({ report: 1, status: 0 });
});

test('while the first pass has not started, it checks the cheap status and keeps the skeleton', async ({ page }) => {
  const card = await openHome(page, report({ index: { ...finished, lastScanStartedMs: null, lastScanFinishedMs: null } }));
  await expect(card).toContainText('Reading transcript files…');
  await expect.poll(async () => (await usageCalls(page)).status, { timeout: 10_000 }).toBeGreaterThan(0);
  expect((await usageCalls(page)).report).toBe(1);
});

test('loading and populated have the same footprint', async ({ page }) => {
  const box = async () => {
    const card = await page.getByTestId('home-usage-card').boundingBox();
    const line = await page.getByText(/^New here\? Start a Session/).boundingBox();
    return { height: card?.height, lineTop: line?.y };
  };
  await openHome(page, report({ index: { ...finished, lastScanFinishedMs: null, scanning: true, filesScanned: 3, filesTotal: 9 } }));
  await expect(page.getByTestId('home-usage-card')).toContainText('Reading 3 of 9 transcript files…');
  const loading = await box();
  await openHome(page, POPULATED);
  await expect(page.getByTestId('home-usage-card')).toContainText('42 messages');
  expect(await box()).toEqual(loading);
});

test("Get Started's New opens the sidebar's New dialog", async ({ page }) => {
  await openHome(page, POPULATED);
  // Home's tile, not the sidebar's New button of the same name.
  await page.locator('button:not([data-testid="sidebar"] button)').filter({ hasText: /^New$/ }).click();
  await expect(page.getByRole('dialog', { name: 'New', exact: true })).toBeVisible();
});
