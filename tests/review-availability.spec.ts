import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock, gotoApp } from './electronApiMock';
import { baseGitStatus, createSession, openSession, panels, project } from './reviewAvailabilityFixture';

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  await page.mouse.move(1_000, 650);
  await page.waitForTimeout(300);
  const path = testInfo.outputPath(filename);
  await page.screenshot({ path });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('Pinned panes show the pane name with the repository name beside it', async ({ page }, testInfo) => {
  const pinnedProject = {
    ...project,
    name: 'bloomapi/bloom-mono',
  };
  const pinnedSession = {
    ...createSession(),
    name: 'do-tm-560',
    isFavorite: true,
  };

  await installElectronApiMock(page, {
    initialProjects: [pinnedProject],
    initialSessions: [pinnedSession],
    initialPanels: panels,
    activeProjectId: pinnedProject.id,
  });
  await gotoApp(page);

  // The row is named for the Pane; the repository sits beside it without its owner.
  const pinnedPane = page.getByRole('button', { name: 'do-tm-560', exact: true });
  await expect(pinnedPane).toBeVisible();
  const pinnedRow = pinnedPane.locator('..');
  await expect(pinnedRow.getByText('bloom-mono', { exact: true })).toBeVisible();
  await expect(pinnedRow).not.toContainText('bloomapi');
  await capture(page, testInfo, '00-pinned-pane-short-label.png');
});

test('New panes start with the inspector shown and the toggle hides it', async ({ page }, testInfo) => {
  await openSession(page, baseGitStatus, {
    initialPanels: [
      ...panels,
      {
        id: 'review-logs',
        sessionId: 'review-session',
        type: 'logs',
        title: 'Logs',
        state: { isActive: false, hasBeenViewed: true, customState: { isRunning: false } },
        metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 3 },
      },
    ],
  });
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();

  const detailPanel = page.locator('.pane-detail-panel-vertical');
  const detailToggle = page.getByRole('button', { name: 'Hide details', exact: true });
  await expect(detailToggle).toBeVisible();
  await expect(detailPanel).not.toHaveCSS('width', '0px');
  await expect(page.getByRole('tablist', { name: 'Inspector' })).toBeVisible();

  const path = testInfo.outputPath('04-inspector-default-shown.png');
  await page.screenshot({ path });
  await testInfo.attach('04-inspector-default-shown.png', { path, contentType: 'image/png' });

  await detailToggle.hover();
  await expect(page.getByRole('tooltip')).toContainText('Hide details');
  await detailToggle.click();
  await expect(page.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();
  await expect(detailPanel).toHaveCSS('width', '0px');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Expand project Review fixture$/ }).click();
  await page.getByRole('button', { name: 'Review changes before PR', exact: true }).click();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show details', exact: true })).toBeVisible();
  await expect(page.locator('.pane-detail-panel-vertical')).toHaveCSS('width', '0px');
});

test('Review stays local until a newly discovered pull request is explicitly opened', async ({ page }, testInfo) => {
  await openSession(page);

  const executionCount = await page.evaluate(async () => {
    const response = await window.electronAPI.sessions.getExecutions('review-session');
    return response.data?.length ?? 0;
  });
  expect(executionCount).toBe(1);

  const reviewTab = page.getByRole('tab', { name: 'Changes', exact: true });
  await expect(reviewTab).toBeEnabled();
  await reviewTab.click();

  const openPullRequest = page.getByRole('button', { name: 'Open PR', exact: true });
  await expect(openPullRequest).toBeDisabled();
  await expect(openPullRequest).toHaveAttribute('title', 'No pull request yet');
  await expect(page.getByText('Local changes', { exact: true })).toBeVisible();
  const diffSummary = page.locator('.combined-diff-view').getByText(/^All changes/).locator('..');
  await expect(diffSummary.getByText('+8', { exact: true })).toBeVisible();
  await expect(diffSummary.getByText('-3', { exact: true })).toBeVisible();

  // Files in Changes open as center diff tabs (preview on single-click), not inline.
  const reviewFile = page.getByRole('option', {
    name: 'Open diff for src/review.ts, Modified, +8 −3',
    exact: true,
  });
  await reviewFile.click();
  const diffTab = page.getByRole('tab', { name: 'review.ts (All changes)', exact: true });
  await expect(diffTab).toHaveAttribute('aria-selected', 'true');
  await expect(reviewFile).toHaveAttribute('aria-current', 'true');
  const splitMode = page.getByRole('button', { name: 'Split', exact: true });
  await splitMode.click();
  await expect(splitMode).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await reviewTab.click();
  await expect(diffTab).toHaveAttribute('aria-selected', 'true');
  await capture(page, testInfo, '01-local-review-before-pr.png');

  await page.evaluate((gitStatus) => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const mock = (window as typeof window & {
      __paneTestElectronMock: {
        emitGitStatusUpdated: (sessionId: string, status: JsonObject) => void;
      };
    }).__paneTestElectronMock;
    mock.emitGitStatusUpdated('review-session', gitStatus);
  }, {
    ...baseGitStatus,
    prNumber: 374,
    prTitle: 'Review local changes before a PR',
    prUrl: 'https://github.com/dcouple/Pane/pull/374',
  });

  await expect(openPullRequest).toBeEnabled();
  await expect(page.locator('.diff-panel').getByText('#374', { exact: true })).toBeVisible();
  await capture(page, testInfo, '02-pr-discovered-local-preserved.png');

  await openPullRequest.click();
  const browserTab = page.getByRole('tab', { name: 'PR #374', exact: true });
  await expect(browserTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByPlaceholder('Enter a URL (e.g. localhost:3000)')).toHaveValue(
    'https://github.com/dcouple/Pane/pull/374/files',
  );
  await capture(page, testInfo, '03-pull-request-browser-tab.png');

  await reviewTab.click();
  await expect(reviewFile).toBeVisible();
  await diffTab.click();
  await expect(diffTab).toHaveAttribute('aria-selected', 'true');
  await expect(splitMode).toHaveAttribute('aria-pressed', 'true');
});

test('Review shows a clean local empty state before a pull request exists', async ({ page }) => {
  await openSession(page, baseGitStatus, { withLocalChanges: false });

  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open PR', exact: true })).toBeDisabled();
  await expect(page.getByText('No changes to review', { exact: true })).toBeVisible();
});

test('Review stays local when the worktree already has a pull request', async ({ page }) => {
  await openSession(page, {
    ...baseGitStatus,
    prNumber: 374,
    prTitle: 'Review local changes before a PR',
    prUrl: 'https://github.com/dcouple/Pane/pull/374',
  });

  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open PR', exact: true })).toBeEnabled();
  await expect(page.getByRole('option', {
    name: 'Open diff for src/review.ts, Modified, +8 −3',
    exact: true,
  })).toBeVisible();
});

test('Legacy GitHub review preference stays local and opens the PR in Browser', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pane-review-default-mode', 'github');
  });
  await openSession(page, {
    ...baseGitStatus,
    prNumber: 571,
    prTitle: 'feat(provider-network): registry enrichment for every supported domain identity version',
    prUrl: 'https://github.com/dcouple/Pane/pull/571',
  });

  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  const inspector = page.locator('.pane-detail-panel-vertical');
  const openPullRequest = page.getByRole('button', { name: 'Open PR', exact: true });

  await expect(page.getByRole('option', {
    name: 'Open diff for src/review.ts, Modified, +8 −3',
    exact: true,
  })).toBeVisible();
  await expect(openPullRequest).toBeInViewport();
  const [inspectorBounds, openPullRequestBounds] = await Promise.all([
    inspector.boundingBox(),
    openPullRequest.boundingBox(),
  ]);
  expect(inspectorBounds).not.toBeNull();
  expect(openPullRequestBounds).not.toBeNull();
  expect(openPullRequestBounds!.x + openPullRequestBounds!.width).toBeLessThanOrEqual(
    inspectorBounds!.x + inspectorBounds!.width,
  );

  await openPullRequest.click();
  await expect(page.getByRole('tab', { name: 'PR #571', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByPlaceholder('Enter a URL (e.g. localhost:3000)')).toHaveValue(
    'https://github.com/dcouple/Pane/pull/571/files',
  );
});

declare global {
  interface Window { __gitRefreshReads: { graph: number; diff: number } }
}

for (const view of ['graph', 'diff'] as const) {
  test(`${view} refresh ignores other panes and follows its own git changes`, async ({ page }, testInfo) => {
    await openSession(page, baseGitStatus, { withLocalChanges: true }, async browser => {
      await browser.addInitScript(() => {
        window.__gitRefreshReads = { graph: 0, diff: 0 };
        window.electronAPI.sessions.getGitGraph = async () => {
          window.__gitRefreshReads.graph++;
          return { success: true, data: { entries: [{
            hash: '1234567890abcdef', parents: [], branch: 'review', message: 'Implement scoped refresh',
            committerDate: '2026-08-06T12:00:00.000Z', author: 'Pane QA',
          }], currentBranch: 'review' } };
        };
        const getFileDiff = window.electronAPI.sessions.getFileDiff;
        window.electronAPI.sessions.getFileDiff = (...args) => {
          window.__gitRefreshReads.diff++;
          return getFileDiff(...args);
        };
      });
    });
    if (view === 'graph') {
      await page.getByRole('tab', { name: 'Details', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Commit history' }).getByText('Implement scoped refresh', { exact: true })).toBeVisible();
    } else {
      await page.getByRole('tab', { name: 'Changes', exact: true }).click();
      await page.getByRole('option', { name: 'Open diff for src/review.ts, Modified, +8 −3', exact: true }).click();
      await expect(page.getByRole('tab', { name: 'review.ts (All changes)', exact: true })).toHaveAttribute('aria-selected', 'true');
    }
    await expect.poll(() => page.evaluate(key => window.__gitRefreshReads[key], view)).toBeGreaterThan(0);
    const initialReads = await page.evaluate(key => window.__gitRefreshReads[key], view);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('panel:event', { detail: {
      type: 'git:operation_completed', source: { sessionId: 'another-pane', panelId: 'git', panelType: 'git' }, data: {}, timestamp: new Date().toISOString(),
    } })));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('git-status-updated', { detail: {
      sessionId: 'another-pane', gitStatus: { state: 'modified', filesChanged: 2 },
    } })));
    // Allow the React effect and resulting IPC request to run before counting.
    await page.waitForTimeout(200);
    expect(await page.evaluate(key => window.__gitRefreshReads[key], view)).toBe(initialReads);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('panel:event', { detail: {
      type: 'git:operation_completed', source: { sessionId: 'review-session', panelId: 'git', panelType: 'git' }, data: {}, timestamp: new Date().toISOString(),
    } })));
    await expect.poll(() => page.evaluate(key => window.__gitRefreshReads[key], view)).toBe(initialReads + 1);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('git-status-updated', { detail: {
      sessionId: 'review-session', gitStatus: { state: 'modified', filesChanged: 2 },
    } })));
    await expect.poll(() => page.evaluate(key => window.__gitRefreshReads[key], view)).toBe(initialReads + 2);
    await page.screenshot({ path: testInfo.outputPath(`${view}-scoped-refresh.png`) });
  });
}
