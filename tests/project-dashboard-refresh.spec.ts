import { expect, test, type Page } from '@playwright/test';
import type { ProjectDashboardData, ProjectDashboardUpdateEvent } from '../frontend/src/types/projectDashboard';
import { installElectronApiMock } from './electronApiMock';

const dashboard: ProjectDashboardData = {
  projectId: 921, projectName: 'Dashboard fixture', projectPath: '/tmp/dashboard-fixture', mainBranch: 'main',
  lastRefreshed: '2026-08-06T12:00:00.000Z',
  mainBranchStatus: { status: 'up-to-date', lastFetched: '2026-08-06T12:00:00.000Z' },
  sessionBranches: [{
    sessionId: 'dashboard-pane', sessionName: 'Existing branch', branchName: 'feature/existing',
    worktreePath: '/tmp/dashboard-fixture/branch', baseCommit: 'a'.repeat(40), baseBranch: 'main',
    isStale: false, hasUncommittedChanges: false, commitsAhead: 1, commitsBehind: 0,
  }],
};

declare global {
  interface Window {
    __dashboardTransport: {
      reads: number;
      hold: boolean;
      update: (event: ProjectDashboardUpdateEvent) => void;
      resolve: (request: number, data: ProjectDashboardData) => void;
    };
  }
}

async function openDashboard(page: Page): Promise<void> {
  const session = {
    id: 'dashboard-pane', name: 'Dashboard pane', projectId: 921, worktreePath: '/tmp/dashboard-fixture/branch',
    prompt: '', status: 'stopped', createdAt: dashboard.lastRefreshed, lastActivity: dashboard.lastRefreshed,
    output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', displayOrder: 0,
    isFavorite: false, toolType: 'none', archived: false,
  };
  await installElectronApiMock(page, {
    initialProjects: [{ id: 921, name: 'Dashboard fixture', path: '/tmp/dashboard-fixture', active: true, created_at: dashboard.lastRefreshed, updated_at: dashboard.lastRefreshed }],
    initialSessions: [session],
    initialPanels: [{ id: 'dashboard-panel', sessionId: session.id, type: 'dashboard', title: 'Dashboard', state: { isActive: true, hasBeenViewed: true }, metadata: { createdAt: dashboard.lastRefreshed, lastActiveAt: dashboard.lastRefreshed, position: 0 } }],
    activeProjectId: 921,
  });
  await page.addInitScript(data => {
    const listeners = new Set<(event: ProjectDashboardUpdateEvent) => void>();
    const pending = new Map<number, (value: { success: boolean; data: ProjectDashboardData }) => void>();
    window.__dashboardTransport = {
      reads: 0, hold: false,
      update: event => listeners.forEach(listener => listener(event)),
      resolve: (request, result) => { pending.get(request)?.({ success: true, data: result }); pending.delete(request); },
    };
    window.electronAPI.dashboard = {
      getProjectStatus: async () => ({ success: true, data }),
      getProjectStatusProgressive: async () => {
        const request = ++window.__dashboardTransport.reads;
        if (!window.__dashboardTransport.hold) return { success: true, data };
        return new Promise(resolve => pending.set(request, resolve));
      },
      onUpdate: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onSessionUpdate: () => () => {},
    };
  }, dashboard);
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand repository Dashboard fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Dashboard pane', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Project Dashboard' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Existing branch/ })).toBeVisible();
  await page.evaluate(() => { window.__dashboardTransport.hold = true; window.__dashboardTransport.reads = 0; });
}

test('refresh keeps existing branches through partial seeds and clears them on a full empty result', async ({ page }, testInfo) => {
  await openDashboard(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__dashboardTransport.reads)).toBe(1);
  await page.evaluate(data => window.__dashboardTransport.update({ projectId: data.projectId, isPartial: true, data: { ...data, sessionBranches: [] } }), dashboard);
  await expect(page.getByRole('row', { name: /Existing branch/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('partial-refresh-keeps-branches.png') });
  await page.evaluate(data => window.__dashboardTransport.resolve(1, { ...data, sessionBranches: [] }), dashboard);
  await expect(page.getByText('No active pane branches', { exact: true })).toBeVisible();
});

test('an older dashboard request cannot overwrite a newer completed refresh', async ({ page }, testInfo) => {
  await openDashboard(page);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__dashboardTransport.reads)).toBe(1);
  await page.evaluate(data => window.__dashboardTransport.update({ projectId: data.projectId, isPartial: false, data }), dashboard);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__dashboardTransport.reads)).toBe(2);
  await page.evaluate(data => window.__dashboardTransport.resolve(2, { ...data, sessionBranches: [{ ...data.sessionBranches[0], sessionName: 'Newest branch result' }] }), dashboard);
  await expect(page.getByRole('row', { name: /Newest branch result/ })).toBeVisible();
  await page.evaluate(data => window.__dashboardTransport.resolve(1, data), dashboard);
  await page.waitForTimeout(100);
  await expect(page.getByRole('row', { name: /Newest branch result/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('newest-request-wins.png') });
});
