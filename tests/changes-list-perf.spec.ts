import { expect, test } from '@playwright/test';
import type { DiffManifest } from '../shared/types/gitDiff';
import { installElectronApiMock } from './electronApiMock';

test('5,000-file list mounts only the viewport and reports paint timing', async ({ page }) => {
  const project = { id: 913, name: 'Perf fixture', path: '/tmp/perf', active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
  const session = { id: 'perf-session', name: 'Performance list', worktreePath: '/tmp/perf/worktree', status: 'stopped', createdAt: new Date(0).toISOString(), lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false, gitStatus: { state: 'modified', ahead: 0, behind: 0, hasUncommittedChanges: true, hasUntrackedFiles: false, filesChanged: 5000, additions: 5000, deletions: 0, totalCommits: 0 } };
  const panels = [{ id: 'perf-terminal', sessionId: session.id, type: 'terminal', title: 'Terminal', state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } }, metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 0, permanent: true } }, { id: 'perf-diff', sessionId: session.id, type: 'diff', title: 'Diff', state: { isActive: false, hasBeenViewed: true }, metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 1, permanent: true } }];
  const files = Array.from({ length: 5000 }, (_, index) => ({ path: `dir-${Math.floor(index / 10).toString().padStart(3, '0')}/file-${index % 10}.txt`, kind: 'modified' as const, additions: 1, deletions: 0, isBinary: false }));
  const manifest: DiffManifest = { scope: { kind: 'session' }, files, resolvedBase: { kind: 'comparison-base', ref: 'main', hash: '1111111111111111111111111111111111111111' }, resolvedTarget: { kind: 'working-tree' }, stats: { additions: 5000, deletions: 0, filesChanged: 5000 } };
  await page.addInitScript(() => {
    const tasks: Array<{ startTime: number; duration: number }> = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push({ startTime: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true });
    Object.assign(window, { __paneDiffLongTasks: tasks });
  });
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: [session], initialPanels: panels, initialExecutions: [], diffManifests: { session: manifest }, initialUiState: { expandedProjects: [project.id] }, activeProjectId: project.id, testPerf: true });
  await page.goto('/');
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  const list = page.getByRole('listbox', { name: 'Changed files' });
  await expect(list).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName('pane-diff-tree-painted').length > 0);
  const mountedRows = await list.getByRole('option').count();
  expect(mountedRows).toBeLessThanOrEqual(40);
  expect(await page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this controller before application code runs.
    const mockWindow = window as typeof window & { __paneTestElectronMock: { getFileDiffCalls: () => unknown[] } };
    return mockWindow.__paneTestElectronMock.getFileDiffCalls().length;
  })).toBe(0);

  await list.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(50);
  const maxMountedRows = Math.max(mountedRows, await list.getByRole('option').count());
  const metrics = await page.evaluate(() => {
    // Receipt-to-paint is the first painted frame after the last manifest receipt.
    // The mark names are historical -- they date from the folder tree this list replaced.
    const receipt = performance.getEntriesByName('pane-diff-manifest-received').at(-1)?.startTime ?? 0;
    const paints = performance.getEntriesByName('pane-diff-tree-painted').map(entry => entry.startTime).filter(time => time >= receipt);
    const commits = performance.getEntriesByName('pane-diff-tree-committed').map(entry => entry.startTime).filter(time => time >= receipt);
    const painted = paints[0] ?? receipt;
    // SAFETY: The test's init script installs this measurement array before application code runs.
    const tasks = (window as typeof window & { __paneDiffLongTasks: Array<{ startTime: number; duration: number }> }).__paneDiffLongTasks;
    return {
      paintCount: paints.length,
      commitCount: commits.length,
      receiptToPaintMs: painted - receipt,
      maxLongTaskMs: Math.max(0, ...tasks.filter(task => task.startTime >= receipt).map(task => task.duration)),
    };
  });
  console.log(JSON.stringify({ ...metrics, maxMountedRows }));
  expect(metrics.paintCount).toBeGreaterThan(0);
  expect(metrics.commitCount).toBeGreaterThan(0);
  // Scrolling remounts rows only through virtualization; it never re-marks a commit.
  expect(maxMountedRows).toBeLessThanOrEqual(40);
  if (process.env.PANE_DIFF_BENCH === '1') {
    expect(metrics.receiptToPaintMs).toBeLessThanOrEqual(200);
    expect(metrics.maxLongTaskMs).toBeLessThanOrEqual(50);
  }
});
