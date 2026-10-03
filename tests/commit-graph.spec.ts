import path from 'path';
import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 1,
  name: 'Pane',
  path: '/tmp/pane',
  active: true,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const mainRef = {
  kind: 'localBranch',
  name: 'main',
  hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  isCurrent: true,
  ahead: 0,
  behind: 0,
};

const featureRef = {
  kind: 'localBranch',
  name: 'feature/commit-graph',
  hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  isCurrent: false,
  ahead: 3,
  behind: 1,
};

const graph = {
  nodes: [
    {
      hash: featureRef.hash,
      shortHash: 'bbbbbbb',
      parents: [mainRef.hash],
      subject: 'Add a repository-wide commit graph',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      authorDate: '2026-08-23T18:00:00.000Z',
      refs: [featureRef],
    },
    {
      hash: mainRef.hash,
      shortHash: 'aaaaaaa',
      parents: [],
      subject: 'Release v2.4.70',
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      authorDate: '2026-08-22T18:00:00.000Z',
      refs: [mainRef],
    },
  ],
  refs: [featureRef, mainRef],
  currentBranch: 'main',
  paneWorktrees: [{
    path: '/tmp/pane/worktrees/commit-graph',
    branch: 'feature/commit-graph',
    sessionId: 'graph-session',
    sessionName: 'Commit graph work',
    isMainCheckout: false,
  }],
  truncated: false,
  limit: 300,
  remotes: ['origin', 'upstream'],
  remoteScope: 'origin',
};

const commitDetail = {
  diff: 'diff --git a/src/graph.ts b/src/graph.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/graph.ts\n@@ -0,0 +1 @@\n+export const graph = true;\n',
  stats: { additions: 1, deletions: 0, filesChanged: 1 },
  changedFiles: ['src/graph.ts'],
  afterHash: featureRef.hash,
};

test('repository commit graph supports navigation, detail, filtering, and keyboard selection', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installElectronApiMock(page, {
    initialConfig: { theme: 'night-owl' },
    initialProjects: [project],
    activeProjectId: 1,
    initialUiState: {
      expandedProjects: [1],
      pinnedSectionExpanded: true,
      repositoriesSectionExpanded: true,
    },
    initialGitGraph: graph,
    initialCommitDetail: commitDetail,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Repository actions for Pane' }).click();
  await page.getByRole('menuitem', { name: 'Commit graph' }).click();

  await expect(page.getByRole('heading', { name: 'Commit graph', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select commit Add a repository-wide commit graph' })).toBeVisible();
  await expect(page.getByText('src/graph.ts', { exact: true })).toBeVisible();
  await expect(page.getByRole('complementary').getByText('+1', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('feature/commit-graph', { exact: true }).first()).toBeVisible();

  await page.waitForTimeout(750);
  await page.screenshot({
    path: path.resolve('tmp/pr-384-qa/01-commit-graph-default.png'),
    fullPage: true,
  });

  const filter = page.getByRole('searchbox', { name: 'Filter commits by subject, author, hash or ref' });
  await filter.fill('Grace');
  await expect(page.getByText('1 of 2 commits match')).toBeVisible();
  await expect(page.getByText('Release v2.4.70', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select commit Add a repository-wide commit graph' })).toHaveCount(0);

  await page.screenshot({
    path: path.resolve('tmp/pr-384-qa/02-commit-graph-filtered.png'),
    fullPage: true,
  });

  await filter.fill('');
  await filter.blur();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Select commit Release v2.4.70' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('navigation', { name: 'Compact sidebar' })).toBeVisible();
  await page.getByTestId('compact-repository-graph-1').click();
  await expect(page.getByRole('heading', { name: 'Commit graph', exact: true })).toBeVisible();
});
