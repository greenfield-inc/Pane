import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { DiffManifest } from '../shared/types/gitDiff';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 391,
  name: 'Commit dialog fixture',
  path: '/tmp/commit-dialog-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const gitStatus = {
  state: 'clean',
  ahead: 0,
  behind: 0,
  hasUncommittedChanges: true,
  hasUntrackedFiles: false,
  filesChanged: 1,
  additions: 3,
  deletions: 1,
  totalCommits: 0,
};

const baseSession = {
  id: 'commit-dialog-session',
  name: 'Commit dialog changes',
  worktreePath: '/tmp/commit-dialog-fixture/commit-dialog-session',
  prompt: 'Verify commit message fields',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  baseBranch: 'main',
  gitStatus,
};

function createSession(overrides: Partial<typeof baseSession> & { isMainRepo?: boolean } = {}) {
  return { ...baseSession, ...overrides };
}

const manifest: DiffManifest = {
  scope: { kind: 'session' },
  files: [{ path: 'src/example.ts', kind: 'modified', additions: 1, deletions: 1, isBinary: false }],
  resolvedBase: { kind: 'comparison-base', ref: 'main', hash: '1111111111111111111111111111111111111111' },
  resolvedTarget: { kind: 'working-tree' },
  stats: { additions: 1, deletions: 1, filesChanged: 1 },
};

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('main repository commit dialog submits title and description with Ctrl+Enter', async ({ page }, testInfo) => {
  const mainSession = createSession({
    id: 'commit-dialog-main',
    name: 'Commit dialog fixture (Main)',
    worktreePath: project.path,
    isMainRepo: true,
  });

  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [mainSession],
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  await page.locator('.pane-detail-panel-vertical').getByRole('button', { name: 'Commit 1 file', exact: true }).click();

  const dialog = page.getByRole('dialog');
  const title = dialog.getByLabel('Title');
  const description = dialog.getByLabel('Description (optional)');
  await expect(title).toBeVisible();
  await expect(description).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();

  await title.fill('Refine commit workflow');
  await description.fill('Keep title and description separate in the UI.');
  await capture(page, testInfo, '01-main-repository-commit-dialog-filled.png');
  await description.press('Control+Enter');

  await expect(dialog).toHaveCount(0);
  // SAFETY: installElectronApiMock creates this test-only bridge and owns the returned call shape.
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __paneTestElectronMock: {
        getGitStageAndCommitCalls: () => Array<{ sessionId: string; message: string }>;
      };
    }
  ).__paneTestElectronMock.getGitStageAndCommitCalls())).toEqual([{
    sessionId: mainSession.id,
    message: 'Refine commit workflow\n\nKeep title and description separate in the UI.',
  }]);
});

test('review commit dialog keeps its default title and submits the composed message', async ({ page }, testInfo) => {
  const session = createSession();
  const panels = [{
    id: 'commit-dialog-diff',
    sessionId: session.id,
    type: 'diff',
    title: 'Review',
    state: { isActive: true, hasBeenViewed: true },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
  }];
  const executions = [{
    id: 0,
    session_id: session.id,
    execution_sequence: 0,
    after_commit_hash: 'UNCOMMITTED',
    commit_message: 'Uncommitted changes',
    timestamp: new Date(0).toISOString(),
    stats_additions: 1,
    stats_deletions: 1,
    stats_files_changed: 1,
    author: 'Pane QA',
    comparison_branch: 'main',
    history_source: 'branch',
  }];

  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialExecutions: executions,
    diffManifests: { session: manifest },
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('tab', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Commit', exact: true }).click();

  const dialog = page.getByRole('dialog');
  const title = dialog.getByLabel('Title');
  const description = dialog.getByLabel('Description (optional)');
  await expect(title).toHaveValue('Update 1 file');
  await description.fill('Explain the reviewed changes.');
  await capture(page, testInfo, '02-review-commit-dialog-filled.png');
  await description.press('Control+Enter');

  await expect(dialog).toHaveCount(0);
});
