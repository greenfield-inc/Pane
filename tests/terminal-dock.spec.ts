import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { TerminalPanelState } from '../shared/types/panels';

const now = new Date(0).toISOString();
const project = { id: 814, name: 'Dock fixture', path: '/tmp/dock-fixture', active: true, created_at: now, updated_at: now };
const pane = {
  id: 'dock-pane', name: 'Agent pane', projectId: project.id,
  worktreePath: `${project.path}/agent`, isMainRepo: false, prompt: '', status: 'stopped',
  createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', toolType: 'none', archived: false, displayOrder: 0,
};
const otherPane = { ...pane, id: 'dock-other', name: 'Other pane', displayOrder: 1 };
const terminal = (id: string, title: string, customState: TerminalPanelState, isActive = false) => ({
  id, sessionId: pane.id, type: 'terminal', title,
  state: { isActive, customState },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
});
const emptyLayout = {
  version: 1, focusedGroupId: 'empty',
  root: { type: 'group', id: 'empty', panelIds: [], activePanelId: null },
};

async function openPane(page: Page, name = pane.name) {
  const expand = page.getByRole('button', { name: `Expand repository ${project.name}`, exact: true });
  await expect(page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true })).toBeVisible();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name, exact: true }).click();
}

// Closing a pane's shell (the main-repo view shows it as a tab) leaves only its agent.
for (const [label, customState] of [
  ['its launch command', { initialCommand: 'codex --yolo' }],
  ['runtime metadata only', { agentType: 'codex', isCliPanel: true }],
] as const) {
  test(`an agent-only pane keeps the agent in a tab (${label})`, async ({ page }) => {
    await installElectronApiMock(page, {
      initialProjects: [project], initialSessions: [pane], activeProjectId: project.id,
      initialPanels: [terminal('codex', 'Codex', customState, true)],
      // Old persisted layouts omitted the agent when it was mistaken for the dock.
      initialLayout: emptyLayout,
    });
    await page.goto('/');
    await openPane(page);
    await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();
    await expect(page.locator('.pane-terminal-dock')).toHaveCount(0);
  });
}

for (const split of [false, true]) {
  test(`deleting the dock shell promotes the next plain shell out of a ${split ? 'split' : 'single'} layout`, async ({ page }) => {
    const dockShell = terminal('dock-shell', 'Terminal', {});
    const extraShell = terminal('extra-shell', 'Extra shell', {}, true);
    const agent = terminal('codex', 'Codex', { initialCommand: 'codex --yolo' });
    await installElectronApiMock(page, {
      initialProjects: [project], initialSessions: [pane, otherPane], activeProjectId: project.id,
      initialPanels: [dockShell, extraShell, agent],
      initialLayout: split ? {
        version: 1, focusedGroupId: 'shell-group', zoomedGroupId: 'shell-group',
        root: {
          type: 'split', id: 'split', direction: 'row', sizes: [1, 1],
          children: [
            { type: 'group', id: 'shell-group', panelIds: [extraShell.id], activePanelId: extraShell.id },
            { type: 'group', id: 'agent-group', panelIds: [agent.id], activePanelId: agent.id },
          ],
        },
      } : {
        version: 1, focusedGroupId: 'agent-group',
        root: { type: 'group', id: 'agent-group', panelIds: [extraShell.id, agent.id], activePanelId: extraShell.id },
      },
    });
    await page.goto('/');
    await openPane(page);
    await expect(page.getByRole('tab', { name: 'Extra shell', exact: true })).toBeVisible();

    await page.evaluate(id => window.electronAPI.panels.deletePanel(id), dockShell.id);

    const codexTab = page.getByRole('tab', { name: 'Codex', exact: true });
    await expect(codexTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Extra shell', exact: true })).toHaveCount(0);
    await expect(page.locator('.pane-terminal-dock')).toBeVisible();
    await expect.poll(() => page.evaluate(async id => {
      return (await window.electronAPI.invoke('panels:get-layout', id)).data;
    }, pane.id)).toEqual({
      version: 1, focusedGroupId: 'agent-group', zoomedGroupId: null,
      root: { type: 'group', id: 'agent-group', panelIds: [agent.id], activePanelId: agent.id },
    });

    await openPane(page, otherPane.name);
    await openPane(page);
    await expect(codexTab).toHaveAttribute('aria-selected', 'true');
  });
}
