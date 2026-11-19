import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, gotoApp } from './electronApiMock';

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

// Markdown previews read through file:preview-url and a fetch (b54794b21). Serve each
// file's content from a same-origin route, as tests/find-in-tab.spec.ts does.
async function servePreviews(page: Page, contents: Record<string, string>) {
  await page.route('**/__diagram-preview/**', (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    const body = contents[name] ?? '';
    return route.fulfill({
      status: 206,
      body,
      contentType: 'text/markdown',
      headers: { 'Content-Range': `bytes 0-${Math.max(0, Buffer.byteLength(body) - 1)}/${Buffer.byteLength(body)}` },
    });
  });
  await page.addInitScript(() => {
    const wrap = () => {
      const api = window.electronAPI;
      if (!api) return false;
      const invoke = api.invoke;
      api.invoke = (channel: string, ...args: unknown[]) => {
        if (channel === 'file:preview-url') {
          // SAFETY: file:preview-url receives the documented { sessionId, filePath } request.
          const { filePath } = args[0] as { filePath: string };
          return Promise.resolve(`${location.origin}/__diagram-preview/${encodeURIComponent(filePath)}`);
        }
        if (channel === 'file:release-preview') return Promise.resolve();
        return invoke(channel, ...args);
      };
      return true;
    };
    if (!wrap()) document.addEventListener('DOMContentLoaded', wrap, { once: true });
  });
}

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
  await servePreviews(page, {
    'broken.md': '# Broken diagram\n\n```mermaid\nflowchart TD\n A[Broken syntax\n```',
    'diagrams.md': '# Retained diagram\n\n```mermaid\nflowchart TD\n A[Retained diagram] --> B[Still visible]\n```',
  });
  await gotoApp(page);
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
  await servePreviews(page, {
    'diagrams.md': '```mermaid\nflowchart TD\n A[First diagram] --> B[First result]\n```\n\n```mermaid\nflowchart TD\n A[Broken syntax\n```',
  });
  await gotoApp(page);
  await page.clock.setFixedTime(new Date('2026-09-25T00:00:00Z'));
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('⚠ Diagram error:', { exact: true })).toBeVisible();
  await expect(page.locator('.markdown-preview svg').getByText('First result', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('simultaneous-diagrams.png') });
});
