import { _electron, expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installElectronApiMock } from './electronApiMock';

const timestamp = new Date(0).toISOString();
const project = { id: 614, name: 'Offline editor project', path: '/tmp/offline-editor', active: true, created_at: timestamp, updated_at: timestamp };
const session = {
  id: 'offline-editor', name: 'Offline editor pane', worktreePath: '/tmp/offline-editor/worktree',
  status: 'stopped', createdAt: timestamp, lastActivity: timestamp, output: [], jsonMessages: [],
  isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder: 0,
  isFavorite: false, toolType: 'none', archived: false,
};
const panel = {
  id: 'offline-editor-panel', sessionId: session.id, type: 'editor', title: 'offline.ts',
  state: { isActive: true, hasBeenViewed: true, customState: { filePath: 'offline.ts', isPreview: true } },
  metadata: { createdAt: timestamp, lastActiveAt: timestamp, position: 0, permanent: false },
};

test('packaged editor loads local workers and saves with all external requests blocked', async () => {
  const application = await _electron.launch({ args: [resolve(__dirname, 'fixtures/monaco-packaged.cjs')] });
  try {
    const page = await application.firstWindow();
    await installElectronApiMock(page, {
      initialProjects: [project], initialSessions: [session], initialPanels: [panel],
      initialUiState: { expandedProjects: [project.id] }, activeProjectId: project.id,
    });
    await page.addInitScript(() => {
      const invoke = window.electronAPI.invoke;
      // SAFETY: This test adapter replaces only the real file read/write IPC
      // envelopes; all other invokes retain the maintained Electron fixture.
      window.electronAPI.invoke = ((channel: string, ...args: unknown[]) => {
        if (channel === 'file:read') return Promise.resolve({ success: true, content: 'const offline: string = 123;\n' });
        if (channel === 'file:write') {
          // SAFETY: FileEditorView supplies this file-write envelope.
          const request = args[0] as { content: string };
          document.documentElement.dataset.savedEditorContent = request.content;
          return Promise.resolve({ success: true });
        }
        return invoke(channel, ...args);
      }) as typeof invoke;
    });
    const workers: string[] = [];
    const errors: string[] = [];
    page.on('worker', worker => workers.push(worker.url()));
    page.on('pageerror', error => errors.push(error.message));
    // Optional analytics may attempt requests; none can supply editor code or
    // gate startup while this route blocks every external response.
    await page.route(/^https?:\/\//, route => route.abort());
    await page.goto(pathToFileURL(resolve(__dirname, '../frontend/dist/index.html')).href);
    await page.getByRole('button', { name: session.name, exact: true }).click();
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible();
    const input = page.locator('.monaco-editor textarea');
    await input.focus();
    await input.press('ControlOrMeta+a');
    await page.keyboard.type('const offline = true;');
    await input.press('ControlOrMeta+s');
    await expect(page.locator('html')).toHaveAttribute('data-saved-editor-content', 'const offline = true;');
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every(url => url.startsWith('file://'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
  }
});
