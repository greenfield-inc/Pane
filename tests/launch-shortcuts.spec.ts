import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { AGENT_LAUNCH_PRESETS } from '../shared/constants/agentLaunchPresets';
import { installElectronApiMock } from './electronApiMock';

type LaunchMock = {
  getPanelCreates: () => JsonObject[];
};

const project = {
  id: 610,
  name: 'Launch shortcut fixture',
  path: '/tmp/launch-shortcut-fixture',
  active: true,
  environment: 'linux',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const baseSession = {
  prompt: 'Verify agent launch shortcuts',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};

const worktreeSession = { ...baseSession, id: 'launch-worktree', name: 'Launch worktree pane', worktreePath: `${project.path}/wt`, displayOrder: 0 };
const mainSession = { ...baseSession, id: 'launch-main', name: 'Launch main repo', worktreePath: project.path, isMainRepo: true, displayOrder: 1 };

// A pinned (permanent) bottom terminal plus one tab terminal, as the popover spec seeds.
const terminalPanels = (sessionId: string, prefix: string) => ['Bottom Terminal', 'Tab Terminal'].map((title, index) => ({
  id: `${prefix}-${index}`,
  sessionId,
  type: 'terminal',
  title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(), position: index, permanent: index === 0 },
}));
const allPanels = [...terminalPanels(worktreeSession.id, 'wt'), ...terminalPanels(mainSession.id, 'main')];

async function panelCreates(page: Page): Promise<JsonObject[]> {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (window as typeof window & { __paneTestElectronMock: LaunchMock }).__paneTestElectronMock.getPanelCreates());
}

async function openSession(page: Page, sessionName: string) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Launch shortcut fixture$/ }).click();
  await page.getByRole('button', { name: sessionName, exact: true }).click();
  await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.mouse.click(20, 20);
}

for (const preset of AGENT_LAUNCH_PRESETS) {
  for (const view of [worktreeSession, mainSession]) {
    test(`remapped ${preset.title} launch creates exactly one terminal in ${view.isMainRepo ? 'the main-repo view' : 'a worktree pane'}`, async ({ page }) => {
      await installElectronApiMock(page, {
        platform: 'linux',
        initialConfig: { keyboardShortcutOverrides: { [preset.hotkeyId]: 'mod+alt+7' } },
        initialProjects: [project],
        initialSessions: [worktreeSession, mainSession],
        initialPanels: allPanels,
        initialTerminalStates: Object.fromEntries(allPanels.map((panel) => [panel.id, { scrollbackBuffer: 'ready\r\n' }])),
        activeProjectId: project.id,
      });
      await openSession(page, view.name);
      const before = (await panelCreates(page)).length;

      // The default chord no longer launches the agent.
      await page.keyboard.press(`Control+Alt+${preset.hotkeyId === 'add-tool-terminal-claude' ? '3' : preset.hotkeyId === 'add-tool-terminal-codex' ? '4' : '5'}`);
      await page.waitForTimeout(300);
      expect((await panelCreates(page)).length).toBe(before);

      await page.keyboard.press('Control+Alt+7');
      await expect.poll(async () => (await panelCreates(page)).length).toBe(before + 1);
      const created = (await panelCreates(page)).at(-1);
      expect(created).toMatchObject({
        sessionId: view.id,
        type: 'terminal',
        title: preset.title,
        state: { customState: { initialCommand: preset.command } },
      });
      await page.waitForTimeout(300);
      expect((await panelCreates(page)).length).toBe(before + 1);
    });
  }
}
