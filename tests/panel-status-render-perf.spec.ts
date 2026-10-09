import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

interface ReactScanFiber { tag: number }
type RenderCallback = (fiber: ReactScanFiber, renders: { componentName?: string; count: number }[]) => void;
declare global {
  interface Window {
    __REACT_SCAN__?: { ReactScanInternals: { options: { value: { onRender?: RenderCallback } } } };
    __statusRenderCounts: Record<string, number>;
  }
}

const now = new Date(0).toISOString();
const project = { id: 842, name: 'Render fixture', path: '/tmp/render-fixture', active: true, created_at: now, updated_at: now };
const session = (id: string, isMainRepo = false) => ({
  id, name: id, projectId: project.id, worktreePath: `${project.path}/${id}`, isMainRepo,
  prompt: '', status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [],
  permissionMode: 'ignore', toolType: 'none', archived: false, isRunning: false,
});

// Run against a fresh Vite dev server with PANE_REACT_SCAN=1. These count actual
// React renders; production input/frame timings belong in the separate benchmark.
for (const surface of ['session', 'project', 'compact'] as const) {
  test(`background status updates isolate the ${surface} workspace`, async ({ page }, testInfo) => {
    test.skip(process.env.PANE_REACT_SCAN !== '1', 'Requires PANE_REACT_SCAN=1 on the test runner and dev server.');
    await installElectronApiMock(page, {
      initialProjects: [project],
      initialSessions: [session('Foreground'), session('Background'), session('Main', true)],
      initialUiState: { expandedProjects: [project.id] },
    });
    await page.addInitScript(() => {
      const invoke = window.electronAPI.invoke;
      window.electronAPI.invoke = (channel, ...args) => channel === 'panels:agent-statuses'
        ? Promise.resolve({ success: true, data: [] })
        : invoke(channel, ...args);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Foreground', exact: true })).toBeVisible();
    await page.waitForFunction(() => Boolean(window.__REACT_SCAN__));
    await page.evaluate(() => {
      // SAFETY: React Scan's opt-in development build exposes these internals.
      // Capture every callback, avoiding the console reporter's top-20 truncation.
      const target = window;
      const options = target.__REACT_SCAN__!.ReactScanInternals.options.value;
      const previous = options.onRender;
      target.__statusRenderCounts = {};
      options.onRender = (fiber, renders) => {
        previous?.(fiber, renders);
        for (const render of renders) {
          const name = render.componentName ?? 'Anonymous';
          target.__statusRenderCounts[name] = (target.__statusRenderCounts[name] ?? 0) + render.count;
        }
      };
    });
    await page.getByRole('button', { name: 'Foreground', exact: true }).click();
    if (surface === 'project') {
      await page.getByRole('button', { name: 'Project actions for Render fixture', exact: true }).click();
      await page.getByText('Open session on main', { exact: true }).click();
    }
    // Force a sidebar render after instrumentation, including in expanded mode.
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    if (surface !== 'compact') await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    const workspace = surface === 'project' ? 'ProjectView' : 'SessionView';
    await expect.poll(() => page.evaluate(name => window.__statusRenderCounts[name] ?? 0, workspace)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.__statusRenderCounts.Sidebar ?? 0)).toBeGreaterThan(0);
    await page.waitForTimeout(2200);
    await page.evaluate(() => { window.__statusRenderCounts = {}; });
    await page.evaluate(async modulePath => {
      const { usePanelStore }: typeof import('../frontend/src/stores/panelStore') = await import(modulePath);
      for (let index = 0; index < 20; index++) {
        const store = usePanelStore.getState();
        store.setAgentStatus('background-agent', 'Background', index % 2 === 0 ? 'blocked' : 'working');
        store.setActivityStatus('background-agent', 'active', new Date(index + 1).toISOString());
        // Separate commits so automatic batching cannot hide subscription churn.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }
    }, '/src/stores/panelStore.ts');
    const badge = surface === 'compact'
      ? page.getByRole('button', { name: 'Open main workspace for Render fixture', exact: true })
      : page.getByRole('button', { name: 'Background', exact: true }).locator('..');
    await expect(badge.locator('[aria-label="Agent working"]')).toBeVisible();
    const counts = await page.evaluate(() => window.__statusRenderCounts);
    await testInfo.attach('render-counts', { body: JSON.stringify({ surface, updates: 20, counts }, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify({ surface, updates: 20, counts }));
    expect(counts.AgentStatusDot ?? 0).toBeGreaterThan(0);
    expect(counts.Sidebar ?? 0).toBe(0);
    expect(counts[workspace] ?? 0).toBe(0);
  });
}
