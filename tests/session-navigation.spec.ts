import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test('worktree navigation keeps panel state without loading obsolete conversation views', async ({ page }) => {
  const now = new Date(0).toISOString();
  const project = {
    id: 942, name: 'Session navigation fixture', path: '/tmp/session-navigation-fixture',
    active: true, created_at: now, updated_at: now,
  };
  const sessions = ['First pane', 'Second pane'].map((name, index) => ({
    id: `navigation-${index}`, name, worktreePath: `${project.path}/${index}`, prompt: '',
    status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [],
    isRunning: false, projectId: project.id, displayOrder: index, toolType: 'none', archived: false,
    gitStatus: { state: 'clean', ahead: 0, behind: 0, filesChanged: 0 },
  }));
  const panels = sessions.flatMap(session => ['first', 'second'].map((name, index) => ({
    id: `${session.id}-${name}`, sessionId: session.id, type: 'logs', title: `${name} log`,
    state: { isActive: index === 0, hasBeenViewed: true },
    metadata: { createdAt: now, lastActiveAt: now, position: index },
  })));
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: sessions, initialPanels: panels });
  await page.goto('/');
  await expect(page.getByTestId('sidebar').first()).toBeVisible();
  let legacyLoads = 0;
  await page.exposeFunction('recordLegacySessionLoad', () => { legacyLoads++; });
  await page.evaluate(() => {
    // SAFETY: exposeFunction installs this callback on the test page before evaluation.
    const recordLoad = (window as typeof window & { recordLegacySessionLoad: () => Promise<void> }).recordLegacySessionLoad;
    window.electronAPI.sessions.getOutput = async () => {
      await recordLoad();
      return { success: true, data: [] };
    };
    window.electronAPI.sessions.getConversationMessageCount = async () => {
      await recordLoad();
      return { success: true, data: 0 };
    };
    const activePanels = new Map<string, string>();
    const loadPanels = window.electronAPI.panels.getSessionPanels;
    window.electronAPI.panels.setActivePanel = async (sessionId, panelId) => {
      activePanels.set(sessionId, panelId);
      return { success: true };
    };
    window.electronAPI.panels.getSessionPanels = async sessionId => {
      const response = await loadPanels(sessionId);
      const activePanelId = activePanels.get(sessionId);
      return activePanelId ? {
        ...response,
        data: response.data?.map((panel: import('../shared/types/panels').ToolPanel) => ({
          ...panel, state: { ...panel.state, isActive: panel.id === activePanelId },
        })),
      } : response;
    };
  });
  await page.clock.install();
  await page.getByRole('button', { name: 'Expand repository Session navigation fixture', exact: true }).click();
  await page.getByRole('button', { name: 'First pane', exact: true }).click();
  await expect(page.locator('.pane-session-content')).toBeVisible();
  await page.getByRole('tab', { name: /second log/ }).click();
  await expect(page.getByRole('tab', { name: /second log/ })).toHaveAttribute('aria-selected', 'true');
  await page.clock.fastForward(1500);
  await page.getByRole('button', { name: 'Second pane', exact: true }).click();
  await expect(page.getByRole('tab', { name: /first log/ })).toHaveAttribute('aria-selected', 'true');
  await page.clock.fastForward(1500);
  await page.getByRole('button', { name: 'First pane', exact: true }).click();
  await expect(page.getByRole('tab', { name: /second log/ })).toHaveAttribute('aria-selected', 'true');
  await page.clock.fastForward(1500);
  expect(legacyLoads).toBe(0);
});
