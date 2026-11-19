// Shared by review-availability.spec.ts and review-availability.known-bug.spec.ts.
import { expect, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock, gotoApp } from './electronApiMock';

export const project = {
  id: 374,
  name: 'Review fixture',
  path: '/tmp/review-fixture',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

export const baseGitStatus = {
  state: 'clean',
  ahead: 1,
  behind: 0,
  hasUncommittedChanges: false,
  hasUntrackedFiles: false,
  filesChanged: 1,
  additions: 8,
  deletions: 3,
  totalCommits: 1,
};

export type ReviewGitStatus = typeof baseGitStatus & {
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
};

export function createSession(gitStatus: ReviewGitStatus = baseGitStatus) {
  return {
    id: 'review-session',
    name: 'Review changes before PR',
    worktreePath: '/tmp/review-fixture/review-session',
    prompt: 'Verify local and GitHub review modes',
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
    gitStatus,
  };
}

export const panels = [
  {
    id: 'review-terminal',
    sessionId: 'review-session',
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true },
  },
  {
    id: 'review-explorer',
    sessionId: 'review-session',
    type: 'explorer',
    title: 'Explorer',
    state: { isActive: true, hasBeenViewed: true },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 1, permanent: true },
  },
  {
    id: 'review-diff',
    sessionId: 'review-session',
    type: 'diff',
    title: 'Diff',
    state: { isActive: false, hasBeenViewed: true },
    metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 2, permanent: true },
  },
];

const localExecutions = [{
  id: 1,
  session_id: 'review-session',
  execution_sequence: 1,
  after_commit_hash: '1234567890abcdef',
  commit_message: 'Make review available before a PR',
  timestamp: '2026-08-06T12:00:00.000Z',
  stats_additions: 8,
  stats_deletions: 3,
  stats_files_changed: 1,
  author: 'Pane QA',
  comparison_branch: 'origin/main',
  history_source: 'branch',
}];

const localCombinedDiff = {
  diff: [
    'diff --git a/src/review.ts b/src/review.ts',
    'index 1111111..2222222 100644',
    '--- a/src/review.ts',
    '+++ b/src/review.ts',
    '@@ -1,4 +1,9 @@',
    '-export const reviewAvailable = false;',
    '-export const mode = "github";',
    '-export const label = "Unavailable";',
    '+export const reviewAvailable = true;',
    '+export const mode = "local";',
    '+export const label = "Local changes";',
    '+export const githubEnabled = false;',
    '+export const emptyState = "No changes to review";',
  ].join('\n'),
  stats: { additions: 8, deletions: 3, filesChanged: 1 },
  changedFiles: ['src/review.ts'],
};

export async function openSession(
  page: Page,
  gitStatus: ReviewGitStatus = baseGitStatus,
  options: {
    withLocalChanges?: boolean;
    initialPanels?: JsonObject[];
    initialConfig?: JsonObject;
    expectInspector?: boolean;
  } = { withLocalChanges: true },
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<void> {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [createSession(gitStatus)],
    initialPanels: options.initialPanels ?? panels,
    initialExecutions: options.withLocalChanges === false ? [] : localExecutions,
    diffManifests: {
      session: {
        scope: { kind: 'session' },
        files: options.withLocalChanges === false ? [] : [{ path: 'src/review.ts', kind: 'modified', additions: 8, deletions: 3, isBinary: false }],
        resolvedBase: { kind: 'comparison-base', ref: 'main', hash: '1111111111111111111111111111111111111111' },
        resolvedTarget: { kind: 'working-tree' },
        stats: options.withLocalChanges === false ? { additions: 0, deletions: 0, filesChanged: 0 } : localCombinedDiff.stats,
      },
    },
    fileDiffs: options.withLocalChanges === false ? {} : {
      'session:src/review.ts': { file: { path: 'src/review.ts', kind: 'modified', additions: 8, deletions: 3, isBinary: false }, patch: localCombinedDiff.diff, status: 'changed' },
    },
    activeProjectId: project.id,
    initialConfig: options.initialConfig,
  });
  await beforeLoad?.(page);
  await gotoApp(page);
  await page.getByRole('button', { name: /^Expand project Review fixture$/ }).click();
  const paneButton = page.getByRole('button', {
    name: gitStatus.prTitle ?? 'Review changes before PR',
    exact: true,
  });
  await paneButton.click();
  if (options.expectInspector !== false) {
    await expect(page.getByRole('tab', { name: 'Changes', exact: true })).toBeVisible();
  }
}
