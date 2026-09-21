import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test.use({ timezoneId: 'America/Los_Angeles' });

const project = {
  id: 383,
  name: 'Usage fixture',
  path: '/tmp/usage-fixture',
  active: true,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const report = {
  totals: {
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    cacheReadTokens: 4_500_000,
    cacheCreationTokens: 100_000,
    totalTokens: 6_100_000,
    messageCount: 42,
    estimatedCostUsd: 12.34,
    costIncomplete: false,
    cacheSavingsUsd: 9.87,
  },
  series: [
    {
      bucketStartMs: Date.UTC(2026, 7, 22),
      inputTokens: 400_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_500_000,
      cacheCreationTokens: 20_000,
      totalTokens: 2_020_000,
      messageCount: 14,
      estimatedCostUsd: 4,
      costIncomplete: false,
      cacheSavingsUsd: 3,
    },
    {
      bucketStartMs: Date.UTC(2026, 7, 23),
      inputTokens: 800_000,
      outputTokens: 200_000,
      cacheReadTokens: 3_000_000,
      cacheCreationTokens: 80_000,
      totalTokens: 4_080_000,
      messageCount: 28,
      estimatedCostUsd: 8.34,
      costIncomplete: false,
      cacheSavingsUsd: 6.87,
    },
  ],
  byModel: [{
    model: 'gpt-5.6-sol',
    provider: 'codex',
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    cacheReadTokens: 4_500_000,
    cacheCreationTokens: 100_000,
    totalTokens: 6_100_000,
    messageCount: 42,
    estimatedCostUsd: 12.34,
    costIncomplete: false,
    cacheSavingsUsd: 9.87,
  }],
  byProject: [{
    path: project.path,
    label: project.name,
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    cacheReadTokens: 4_500_000,
    cacheCreationTokens: 100_000,
    totalTokens: 6_100_000,
    messageCount: 42,
    estimatedCostUsd: 12.34,
    costIncomplete: false,
    cacheSavingsUsd: 9.87,
  }],
  byPane: {
    panes: [
      {
        paneId: 'pane-cost-engine',
        paneName: 'Cost engine',
        worktreePath: '/tmp/usage-fixture-cost-engine',
        repoId: project.id,
        archived: false,
        createdAtMs: Date.UTC(2026, 7, 1),
        inputTokens: 500_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheCreationTokens: 50_000,
        totalTokens: 2_650_000,
        messageCount: 20,
        estimatedCostUsd: 5.5,
        costIncomplete: false,
        cacheSavingsUsd: 4.5,
        uncachedCostUsd: 5,
        uncachedInputTokens: 500_000,
        cacheHitRate: 0.8,
        byModel: [
          {
            model: 'gpt-5.6-sol',
            provider: 'codex',
            inputTokens: 300_000,
            outputTokens: 60_000,
            cacheReadTokens: 1_200_000,
            cacheCreationTokens: 30_000,
            totalTokens: 1_590_000,
            messageCount: 12,
            estimatedCostUsd: 3.5,
            costIncomplete: false,
            cacheSavingsUsd: 2.8,
          },
          {
            model: 'claude-sonnet-5',
            provider: 'claude',
            inputTokens: 200_000,
            outputTokens: 40_000,
            cacheReadTokens: 800_000,
            cacheCreationTokens: 20_000,
            totalTokens: 1_060_000,
            messageCount: 8,
            estimatedCostUsd: 2,
            costIncomplete: false,
            cacheSavingsUsd: 1.7,
          },
        ],
      },
      {
        paneId: 'pane-docs',
        paneName: 'Docs pane',
        worktreePath: '/tmp/usage-fixture-docs',
        repoId: project.id,
        archived: true,
        createdAtMs: Date.UTC(2026, 7, 2),
        inputTokens: 600_000,
        outputTokens: 180_000,
        cacheReadTokens: 2_000_000,
        cacheCreationTokens: 50_000,
        totalTokens: 2_830_000,
        messageCount: 18,
        estimatedCostUsd: 6,
        costIncomplete: false,
        cacheSavingsUsd: 4.5,
        uncachedCostUsd: 2,
        uncachedInputTokens: 600_000,
        cacheHitRate: 2_000_000 / 2_600_000,
        byModel: [{
          model: 'claude-opus-5',
          provider: 'claude',
          inputTokens: 600_000,
          outputTokens: 180_000,
          cacheReadTokens: 2_000_000,
          cacheCreationTokens: 50_000,
          totalTokens: 2_830_000,
          messageCount: 18,
          estimatedCostUsd: 6,
          costIncomplete: false,
          cacheSavingsUsd: 4.5,
        }],
      },
    ],
    unattributed: {
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 500_000,
      cacheCreationTokens: 0,
      totalTokens: 620_000,
      messageCount: 4,
      estimatedCostUsd: 0.84,
      costIncomplete: false,
      cacheSavingsUsd: 0.87,
      uncachedCostUsd: 0.5,
      uncachedInputTokens: 100_000,
      cacheHitRate: 500_000 / 600_000,
      byModel: [{
        model: 'gpt-5.6-sol',
        provider: 'codex',
        inputTokens: 100_000,
        outputTokens: 20_000,
        cacheReadTokens: 500_000,
        cacheCreationTokens: 0,
        totalTokens: 620_000,
        messageCount: 4,
        estimatedCostUsd: 0.84,
        costIncomplete: false,
        cacheSavingsUsd: 0.87,
      }],
    },
  },
  rateLimits: [{
    provider: 'codex',
    limitId: 'codex',
    scope: 'primary',
    usedPercent: 42,
    windowMinutes: 300,
    resetsAtMs: Date.now() + 60 * 60 * 1000,
    planType: 'plus',
    capturedAtMs: Date.now(),
    creditsHas: false,
    creditsBalance: '0',
    creditsUnlimited: false,
    rateLimitReachedType: null,
    spendControlReached: null,
    limitName: null,
  }],
  index: {
    lastScanStartedMs: Date.now(),
    lastScanFinishedMs: Date.now(),
    filesTracked: 3,
    eventsIndexed: 42,
    missingRoots: [],
    scanning: false,
    filesScanned: 3,
    filesTotal: 3,
    lastError: null,
  },
  pricingAsOf: '2026-08-10',
};

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('opens Usage & Limits from expanded and compact navigation', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialUsageReport: report,
    activeProjectId: project.id,
  });
  await page.setViewportSize({ width: 1_600, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.getByTestId('usage-nav').click();
  await expect(page.getByRole('heading', { name: 'Usage & limits' })).toBeVisible();
  await expect(page.getByText('6.1M', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('gpt-5.6-sol', { exact: true })).toBeVisible();
  await expect(page.getByText('Usage fixture', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('58% left', { exact: true })).toBeVisible();

  // Share and download buttons
  await expect(page.getByRole('button', { name: 'Download usage as image' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share usage image' })).toBeVisible();

  await capture(page, testInfo, '01-usage-dashboard-expanded.png');
  const cadence = page.getByText('Usage is checked every 4 hours; large scans may take longer. Refresh to check now.', { exact: true });
  await cadence.scrollIntoViewIfNeeded();
  await expect(cadence).toBeVisible();
  await expect(page.getByText(/^Last successful scan:/)).toBeVisible();
  await capture(page, testInfo, '04-usage-freshness-footer.png');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByTestId('compact-usage')).toBeVisible();
  await page.getByTestId('compact-usage').click();
  await expect(page.getByRole('heading', { name: 'Usage & limits' })).toBeVisible();

  await page.setViewportSize({ width: 720, height: 760 });
  await expect(page.getByText('Token mix', { exact: true })).toBeVisible();
  await capture(page, testInfo, '02-usage-dashboard-compact-narrow.png');
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('shows sortable per-pane costs, model breakdowns, and unattributed usage', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialUsageReport: report,
    activeProjectId: project.id,
  });
  await page.setViewportSize({ width: 1_600, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('usage-nav').click();

  const section = page.getByTestId('usage-by-pane');
  await expect(section).toBeVisible();
  const rows = section.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Cost engine');
  await expect(rows.nth(1)).toContainText('Docs pane');
  await expect(rows.nth(1)).toContainText('archived');
  await expect(section.getByText(/gpt-5\.6-sol · 1\.6M ·/)).toBeVisible();
  await expect(section.getByText(/claude-sonnet-5 · 1\.1M ·/)).toBeVisible();
  await expect(rows.nth(2)).toContainText('Unattributed');
  await expect(rows.nth(2)).toContainText('$0.84');

  await section.getByRole('button', { name: 'Total' }).click();
  await expect(rows.nth(0)).toContainText('Docs pane');

  const screenshotPath = testInfo.outputPath('03-usage-by-pane.png');
  await section.screenshot({ path: screenshotPath });
  await testInfo.attach('03-usage-by-pane.png', { path: screenshotPath, contentType: 'image/png' });
});

test('per-pane averages exclude unattributed usage and explain small trimmed samples', async ({ page }, testInfo) => {
  await installElectronApiMock(page, { initialProjects: [project], initialUsageReport: report, activeProjectId: project.id });
  await page.goto('/');
  await page.getByTestId('usage-nav').click();
  const summary = page.getByTestId('pane-usage-summary');
  await expect(summary.getByText('740.0K', { exact: true })).toBeVisible();
  await expect(summary.getByText('$5.75', { exact: true })).toBeVisible();
  await expect(summary.getByText('19', { exact: true })).toBeVisible();
  await expect(summary).toContainText('2 panes with recorded usage');
  await summary.getByRole('button', { name: 'Trim 10%' }).click();
  await expect(summary).toContainText('At least 10 panes are needed to trim');
  await expect(summary.getByText('740.0K', { exact: true })).toBeVisible();
  await capture(page, testInfo, '05-pane-averages.png');
});

test('trims each metric independently, ignores empty panes, and preserves missing prices', async ({ page }) => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
  const panes = values.map((value, i) => ({
    ...report.byPane.panes[0], paneId: `sample-${i}`, paneName: `Sample ${i}`,
    inputTokens: value * 1000, outputTokens: 0, cacheCreationTokens: 0,
    totalTokens: value * 1000 + 2_000_000,
    estimatedCostUsd: values[(i + 3) % values.length], messageCount: values[(i + 6) % values.length],
  }));
  panes.push({ ...panes[0], paneId: 'empty', messageCount: 0, inputTokens: 0, totalTokens: 0 });
  await installElectronApiMock(page, {
    initialProjects: [project], initialUsageReport: { ...report, byPane: { ...report.byPane, panes } }, activeProjectId: project.id,
  });
  await page.goto('/');
  await page.getByTestId('usage-nav').click();
  const summary = page.getByTestId('pane-usage-summary');
  await expect(summary).toContainText('10 panes with recorded usage');
  await summary.getByRole('button', { name: 'Trim 10%' }).click();
  await expect(summary.getByText('5.5K', { exact: true })).toBeVisible();
  await expect(summary.getByText('$5.50', { exact: true })).toBeVisible();
  await expect(summary.getByText('5.5', { exact: true })).toBeVisible();
  await expect(summary).toContainText('1 highest and 1 lowest values; 8 panes remain');

  await page.evaluate(() => {
    const usage = window.electronAPI.usage;
    const original = usage.getReport;
    usage.getReport = async (...args) => {
      const response = await original(...args);
      if (response.data) response.data.byPane.panes[0].costIncomplete = true;
      return response;
    };
  });
  await page.getByRole('button', { name: '7d', exact: true }).click();
  await expect(summary.getByText('n/a', { exact: true })).toBeVisible();
  await expect(summary.getByRole('button', { name: 'Trim 10%' })).toHaveAttribute('aria-pressed', 'true');
});

test('custom inclusive local dates reach the API, preserve provider filters, and cancel safely', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installElectronApiMock(page, { initialProjects: [project], initialUsageReport: report, activeProjectId: project.id });
  await page.goto('/');
  await page.getByTestId('usage-nav').click();
  await expect(page.getByTestId('pane-usage-summary')).toBeVisible();
  await page.evaluate(() => {
    const usage = window.electronAPI.usage;
    const original = usage.getReport;
    usage.getReport = async request => {
      sessionStorage.setItem('usage-request', JSON.stringify(request));
      return original(request);
    };
  });
  await page.getByRole('button', { name: 'Choose custom date range' }).click();
  const expectedStart = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 29);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  await expect(page.getByLabel('Start date', { exact: true })).toHaveValue(expectedStart);
  await page.getByLabel('Start date', { exact: true }).fill('2026-03-08');
  await page.getByLabel('End date', { exact: true }).fill('2026-03-07');
  await expect(page.getByRole('button', { name: 'Apply range' })).toBeDisabled();
  await page.getByLabel('End date', { exact: true }).fill('2026-03-08');
  await capture(page, testInfo, '06-custom-date-range.png');
  await page.getByRole('button', { name: 'Apply range' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /^Token usage from 2026-03-08 to 2026-03-08/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const request = JSON.parse(sessionStorage.getItem('usage-request') || '{}');
    const start = new Date(2026, 2, 8).getTime();
    const end = new Date(2026, 2, 9).getTime() - 1;
    return request.fromMs === start && request.toMs === end && request.dayBoundariesMs?.[0] === start && request.dayBoundariesMs?.[1] === end + 1 && end - start + 1 === 23 * 60 * 60 * 1000;
  })).toBe(true);
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('usage-request') || '{}').providers)).toEqual(['codex']);
  await page.getByRole('button', { name: 'Choose custom date range' }).click();
  await page.getByLabel('Start date', { exact: true }).fill('2026-03-01');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose custom date range' })).toContainText('2026-03-08 to 2026-03-08');
  await page.getByRole('button', { name: 'Choose custom date range' }).click();
  await page.getByLabel('Start date', { exact: true }).fill('2025-11-02');
  await page.getByLabel('End date', { exact: true }).fill('2025-11-02');
  await page.getByRole('button', { name: 'Apply range' }).click();
  await expect.poll(() => page.evaluate(() => {
    const request = JSON.parse(sessionStorage.getItem('usage-request') || '{}');
    return request.toMs - request.fromMs + 1;
  })).toBe(25 * 60 * 60 * 1000);
  await page.getByRole('button', { name: '24h', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const request = JSON.parse(sessionStorage.getItem('usage-request') || '{}');
    return request.toMs - request.fromMs;
  })).toBe(86_400_000);
  await expect(page.getByRole('button', { name: 'Choose custom date range' })).toHaveAttribute('aria-pressed', 'false');
});

test('empty pane history shows unavailable averages', async ({ page }) => {
  await installElectronApiMock(page, { initialProjects: [project], initialUsageReport: { ...report, byPane: { ...report.byPane, panes: [] } }, activeProjectId: project.id });
  await page.goto('/');
  await page.getByTestId('usage-nav').click();
  const summary = page.getByTestId('pane-usage-summary');
  await expect(summary.getByText('—', { exact: true })).toHaveCount(3);
  await expect(summary).toContainText('No pane-attributed usage');
});

test('rescan completion keeps the latest filter and late requests cannot replace it', async ({ page }) => {
  await installElectronApiMock(page, { initialProjects: [project], initialUsageReport: report, activeProjectId: project.id });
  await page.goto('/');
  await page.getByTestId('usage-nav').click();
  await expect(page.getByTestId('pane-usage-summary')).toBeVisible();
  await page.evaluate(() => {
    const usage = window.electronAPI.usage;
    const original = usage.getReport;
    usage.rescan = () => new Promise(resolve => {
      window.addEventListener('finish-test-rescan', () => resolve({ success: true }), { once: true });
    });
    usage.getReport = async request => {
      const response = await original(request);
      const codex = request?.providers?.[0] === 'codex';
      if (!codex) await new Promise(resolve => setTimeout(resolve, 200));
      if (response.data) {
        response.data.byPane.panes.forEach(pane => { pane.messageCount = codex ? 123 : 999; });
      }
      return response;
    };
  });
  await page.getByRole('button', { name: 'Rescan transcripts' }).click();
  await page.getByRole('button', { name: '7d', exact: true }).click();
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  const summary = page.getByTestId('pane-usage-summary');
  await expect(summary.getByText('123', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('finish-test-rescan')));
  await expect(page.getByRole('button', { name: 'Rescan transcripts' })).toBeEnabled();
  // Wait past the intentionally delayed old response before checking it was discarded.
  await page.waitForTimeout(300);
  await expect(summary.getByText('123', { exact: true })).toBeVisible();
  await expect(summary.getByText('999', { exact: true })).toHaveCount(0);
});
