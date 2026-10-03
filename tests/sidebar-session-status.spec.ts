import { expect, test } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

test('sidebar drops cleared Git metadata after the host resynchronizes sessions', async ({page}) => {
  const pane = {id: 'status-pane', name: 'Local pane name', projectId: 1,
    worktreePath: '/tmp/status-pane', prompt: '', status: 'stopped',
    createdAt: '2026-01-01T00:00:00Z', output: [], jsonMessages: [], toolType: 'none'};
  await installElectronApiMock(page, {
    initialProjects: [{id: 1, name: 'Repository', path: '/tmp/repo', active: true}],
    initialSessions: [{...pane, gitStatus: {state: 'ahead', ahead: 1, prTitle: 'Old pull request title', prNumber: 123, prState: 'OPEN'}}],
    initialUiState: {expandedProjects: [1], repositoriesSectionExpanded: true},
  });
  await page.goto('/');
  await expect(page.getByText('Old pull request title', {exact: true})).toBeVisible();
  await page.evaluate(nextPane => {
    // SAFETY: installElectronApiMock installs these test-only external IPC controls.
    const mock = (window as typeof window & {__paneTestElectronMock: {
      setSessions(sessions: JsonObject[]): void;
      emitRemoteDaemonResyncRequested(): void;
    }}).__paneTestElectronMock;
    mock.setSessions([nextPane]);
    mock.emitRemoteDaemonResyncRequested();
  }, pane);
  await expect(page.getByText('Old pull request title', {exact: true})).toBeHidden();
  await expect(page.getByText('Local pane name', {exact: true})).toBeVisible();
  await page.screenshot({path: 'tmp/greenfield/pane-audit-fixes/evidence/session-consistency.png', fullPage: true});
});
