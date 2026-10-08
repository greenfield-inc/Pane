import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { ArchiveProgressSnapshot, ArchiveProgressTask } from '../shared/types/archiveProgress';

declare global {
  interface Window {
    __paneTestElectronMock: {
      getInvokeCalls(channel: string): Array<{ args: unknown[] }>;
      emitArchiveProgress(progress: ArchiveProgressSnapshot): void;
      getListenerCount(channel: string): number;
      setArchiveProgress(progress: ArchiveProgressSnapshot): void;
      emitRemoteDaemonResyncRequested(event: { hostChanged: boolean }): void;
    };
  }
}

test('retains cleanup failure across reload and exposes an explicit interrupted-script retry', async ({ page }) => {
  await installElectronApiMock(page, {
    initialArchiveProgress: {
      activeCount: 0, totalCount: 1,
      tasks: [{
        sessionId: 'archive-pane', sessionName: 'Archived feature', worktreeName: 'feature', projectName: 'Repository',
        status: 'failed', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:01:00.000Z',
        error: 'Archive script was interrupted', cleanupId: 'durable-job', interruptedScript: true,
        attempts: 1, remainingPath: '/repo/worktrees/feature',
      }],
    },
    archiveRetryError: 'Cleanup is not ready to retry',
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Archive Tasks' }).click();
  await expect(page.getByText('Archived; cleanup needs attention')).toBeVisible();
  await expect(page.getByText('/repo/worktrees/feature', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Archive Tasks' }).click();
  const retry = page.getByRole('button', { name: 'Retry cleanup (skip interrupted script)' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Cleanup is not ready to retry' })).toBeVisible();
  const calls = await page.evaluate(() => {
    return window.__paneTestElectronMock.getInvokeCalls('archive:retry-cleanup');
  });
  expect(calls.at(-1)?.args).toEqual(['archive-pane', true]);
});

const task = (sessionId: string, status: ArchiveProgressTask['status'], error?: string): ArchiveProgressTask => ({
  sessionId, sessionName: `Pane ${sessionId}`, worktreeName: sessionId, projectName: 'Repository',
  status, startTime: '2026-01-01T00:00:00.000Z', error,
});

const snapshot = (...tasks: ArchiveProgressTask[]): ArchiveProgressSnapshot => ({
  tasks, totalCount: tasks.length,
  activeCount: tasks.filter(item => item.status !== 'completed' && item.status !== 'failed').length,
});

test('archive progress leaves the panel as the user set it and opens it only for a new failure', async ({ page }) => {
  await installElectronApiMock(page);
  await page.goto('/');
  const emit = (progress: ArchiveProgressSnapshot) => page.evaluate(
    value => window.__paneTestElectronMock.emitArchiveProgress(value), progress,
  );
  const header = page.getByRole('button', { name: /Archive Tasks/ });
  await expect.poll(() => page.evaluate(() => window.__paneTestElectronMock.getListenerCount('archive:progress'))).toBe(1);

  await emit(snapshot(task('a', 'queued')));
  await emit(snapshot(task('a', 'removing-worktree')));
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(header.getByText('1 active')).toBeVisible();

  await header.click();
  await emit(snapshot(task('a', 'cleaning-artifacts')));
  await expect(header).toHaveAttribute('aria-expanded', 'true');

  await header.click();
  await emit(snapshot(task('a', 'completed'), task('b', 'pending')));
  await expect(header).toHaveAttribute('aria-expanded', 'false');

  await emit(snapshot(task('a', 'completed'), task('b', 'failed', 'Could not remove worktree')));
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Could not remove worktree', { exact: true })).toBeVisible();
});

test('a failure seen first after a reconnect opens the panel, one from another host does not', async ({ page }) => {
  await installElectronApiMock(page, { initialArchiveProgress: snapshot(task('a', 'removing-worktree')) });
  await page.goto('/');
  const header = page.getByRole('button', { name: /Archive Tasks/ });
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  const resync = (progress: ArchiveProgressSnapshot, hostChanged: boolean) => page.evaluate(([value, changed]) => {
    window.__paneTestElectronMock.setArchiveProgress(value);
    window.__paneTestElectronMock.emitRemoteDaemonResyncRequested({ hostChanged: changed });
  }, [progress, hostChanged] as const);

  await resync(snapshot(task('other-host', 'failed', 'Old failure')), true);
  await expect(header.getByText('1 active')).toBeHidden();
  await expect(header).toHaveAttribute('aria-expanded', 'false');

  await resync(snapshot(task('other-host', 'failed', 'Old failure'), task('b', 'failed', 'Failed while offline')), false);
  await expect(header).toHaveAttribute('aria-expanded', 'true');
});
