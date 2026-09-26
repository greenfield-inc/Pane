import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { AgentState, PanelAgentStatusEvent } from '../shared/types/agentStatus';

declare global {
  interface Window {
    __statusFixture: {
      setSnapshot(state: AgentState): void;
      emit(state: AgentState, reason?: string): void;
      remove(): void;
      reconnect(): void;
      notifications: string[];
    };
  }
}

const now = new Date(0).toISOString();
const project = { id: 841, name: 'Status fixture', path: '/tmp/status-fixture', active: true, created_at: now, updated_at: now };
const session = (id: string) => ({
  id, name: id, projectId: project.id, worktreePath: `${project.path}/${id}`,
  prompt: '', status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [],
  permissionMode: 'ignore', toolType: 'none', archived: false, isRunning: false,
});
const panel = {
  id: 'agent', sessionId: 'Agent pane', type: 'terminal', title: 'Codex',
  state: { isActive: true, customState: { isCliPanel: true, agentType: 'codex', isInitialized: true, isCliReady: true } },
  metadata: { createdAt: now, lastActiveAt: now, position: 1 },
};
// A plain shell comes first so the dock takes it and Codex stays a tab.
const shell = {
  id: 'shell', sessionId: 'Agent pane', type: 'terminal', title: 'Terminal',
  state: { isActive: false, customState: { isInitialized: true } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
};

test('sidebar and tabs reconcile status without announcing snapshot completions', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session('Agent pane'), session('Other pane')], initialPanels: [shell, panel],
    initialUiState: { expandedProjects: [project.id] }, initialConfig: { notifications: { enabled: true, playSound: false } },
  });
  await page.addInitScript(() => {
    const api = window.electronAPI;
    const originalInvoke = api.invoke;
    let snapshotState: AgentState = 'working';
    const statuses = new Set<(data: PanelAgentStatusEvent) => void>();
    const deletions = new Set<(data: { panelId: string; sessionId: string }) => void>();
    const reconnects = new Set<() => void>();
    api.invoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'panels:agent-statuses') return Promise.resolve({ success: true, data: [
        { sessionId: 'Agent pane', panelId: 'agent', state: snapshotState },
      ] });
      return originalInvoke(channel, ...args);
    };
    const originalEvents = api.events;
    api.events = new Proxy(originalEvents, { get(target, key: keyof typeof originalEvents) {
      if (key === 'onPanelAgentStatus') return (callback: (data: PanelAgentStatusEvent) => void) => {
        statuses.add(callback); return () => statuses.delete(callback);
      };
      if (key === 'onPanelDeleted') return (callback: (data: { panelId: string; sessionId: string }) => void) => {
        deletions.add(callback); return () => deletions.delete(callback);
      };
      if (key === 'onRemoteDaemonResyncRequested') return (callback: () => void) => {
        reconnects.add(callback); return () => reconnects.delete(callback);
      };
      return target[key];
    } });
    const notifications: string[] = [];
    Object.defineProperty(window, 'Notification', { configurable: true, value: class {
      static permission = 'granted';
      constructor(title: string) { notifications.push(title); }
    } });
    api.window.isFocused = async () => false;
    window.__statusFixture = {
      setSnapshot: state => { snapshotState = state; },
      emit: (state, reason = 'fixture') => { for (const listener of statuses) listener({ panelId: 'agent', sessionId: 'Agent pane', state, reason }); },
      remove: () => { for (const listener of deletions) listener({ panelId: 'agent', sessionId: 'Agent pane' }); },
      reconnect: () => { for (const listener of reconnects) listener(); },
      notifications,
    };
  });
  await page.goto('/');
  const sidebarPane = page.getByRole('button', { name: 'Agent pane', exact: true });
  await expect(sidebarPane).toBeVisible();
  await expect(sidebarPane.locator('..').locator('[aria-label="Agent working"]')).toBeVisible();
  await sidebarPane.click();
  const tab = page.getByRole('tab', { name: 'Codex', exact: true }).locator('..');
  await expect(tab.locator('[aria-label="Agent working"]')).toBeVisible();

  await page.evaluate(() => { window.__statusFixture.setSnapshot('idle'); window.__statusFixture.reconnect(); });
  await expect(tab.locator('[aria-label="Agent idle"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__statusFixture.notifications.length)).toBe(0);

  await page.getByRole('button', { name: 'Other pane', exact: true }).click();
  for (const reason of ['exit', 'destroyed']) {
    await page.evaluate(reason => { window.__statusFixture.emit('working'); window.__statusFixture.emit('idle', reason); }, reason);
    await expect(sidebarPane.locator('..').locator('[aria-label="Agent idle"]')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__statusFixture.notifications)).toEqual([]);
  }
  await page.evaluate(() => { window.__statusFixture.emit('working'); window.__statusFixture.emit('idle'); });
  await expect(sidebarPane.locator('..').locator('[aria-label="Agent done"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__statusFixture.notifications)).toEqual(['Codex finished']);
  await page.evaluate(() => { window.__statusFixture.emit('working'); window.__statusFixture.remove(); });
  await expect(sidebarPane.locator('..').locator('[aria-label="Agent working"]')).toHaveCount(0);
});
