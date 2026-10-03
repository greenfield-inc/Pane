import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const timestamp = new Date(0).toISOString();
const project = { id: 823, name: 'Diagram fixture', path: '/tmp/diagram-fixture', active: true, created_at: timestamp, updated_at: timestamp };
const session = {
  id: 'diagram-session', name: 'Diagram preview', worktreePath: project.path,
  status: 'stopped', createdAt: timestamp, lastActivity: timestamp, output: [], jsonMessages: [],
  isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder: 0,
  isFavorite: false, toolType: 'none', archived: false,
};
const panel = {
  id: 'diagram-editor', sessionId: session.id, type: 'editor', title: 'diagrams.md',
  state: { isActive: true, hasBeenViewed: true, customState: { filePath: 'diagrams.md', isPinned: true } },
  metadata: { createdAt: timestamp, lastActiveAt: timestamp, position: 0 },
};

test('a broken Markdown diagram leaves a diagram in another split preview visible', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [panel, {
      ...panel, id: 'broken-editor', title: 'broken.md',
      state: { ...panel.state, customState: { filePath: 'broken.md', isPinned: true } },
      metadata: { ...panel.metadata, position: 1 },
    }],
    initialLayout: {
      version: 1, focusedGroupId: 'left',
      root: { type: 'split', id: 'split', direction: 'row', sizes: [1, 1], children: [
        { type: 'group', id: 'left', panelIds: ['diagram-editor'], activePanelId: 'diagram-editor' },
        { type: 'group', id: 'right', panelIds: ['broken-editor'], activePanelId: 'broken-editor' },
      ] },
    },
    initialUiState: { expandedProjects: [project.id] }, activeProjectId: project.id,
  });
  await page.goto('/');
  await page.evaluate(() => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = async (channel, ...args) => {
      if (channel !== 'file:read') return invoke(channel, ...args);
      // SAFETY: file:read receives the documented filePath request object.
      const { filePath } = args[0] as { filePath: string };
      return { success: true, content: filePath === 'broken.md'
        ? '# Broken diagram\n\n```mermaid\nflowchart TD\n A[Broken syntax\n```'
        : '# Retained diagram\n\n```mermaid\nflowchart TD\n A[Retained diagram] --> B[Still visible]\n```' };
    };
  });
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  await expect(page.locator('.markdown-preview svg').getByText('Retained diagram', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).nth(1).click();
  await expect(page.getByText('⚠ Diagram error:', { exact: true })).toBeVisible();
  await expect(page.locator('.markdown-preview svg').getByText('Retained diagram', { exact: true })).toBeVisible();
  await expect(page.locator('.markdown-preview svg').getByText('Still visible', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('diagram-error-isolation.png') });
});

test('a broken diagram cannot remove a neighbor rendered in the same millisecond', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: [panel],
    initialUiState: { expandedProjects: [project.id] }, activeProjectId: project.id,
  });
  await page.goto('/');
  await page.clock.setFixedTime(new Date('2026-09-25T00:00:00Z'));
  await page.evaluate(() => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = async (channel, ...args) => channel === 'file:read'
      ? { success: true, content: '```mermaid\nflowchart TD\n A[First diagram] --> B[First result]\n```\n\n```mermaid\nflowchart TD\n A[Broken syntax\n```' }
      : invoke(channel, ...args);
  });
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('⚠ Diagram error:', { exact: true })).toBeVisible();
  await expect(page.locator('.markdown-preview svg').getByText('First result', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('simultaneous-diagrams.png') });
});
