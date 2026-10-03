import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = { id: 382, name: 'File link fixture', path: '/tmp/file-link-fixture', active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
const session = {
  id: 'file-link-session', name: 'File link pane', worktreePath: project.path,
  prompt: '', status: 'stopped', createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false,
  toolType: 'none', archived: false,
};
const panels = ['Bottom Terminal', 'File Terminal'].map((title, index) => ({
  id: `file-terminal-${index}`, sessionId: session.id, type: 'terminal', title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(), position: index, permanent: index === 0 },
}));

test('terminal links open worktree files in the editor and explain outside paths', async ({ page }, testInfo) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux' }));
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: panels,
    initialTerminalStates: { [panels[1].id]: { scrollbackBuffer: './src/app.ts:42\r\n~/.zshrc\r\n' } },
    activeProjectId: project.id,
  });
  await page.goto('/');
  await page.evaluate(() => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'terminal:getPathContext') return Promise.resolve({ workingDirectory: '/tmp/file-link-fixture', homeDirectory: '/home/test-user' });
      if (channel === 'file:read') return Promise.resolve({ success: true, content: 'export const fixture = 42;\n' });
      if (channel === 'app:showItemInFolder') {
        document.body.dataset.revealedPath = String(args[0]);
        return Promise.resolve({ success: true });
      }
      if (channel === 'file:exists') {
        // SAFETY: The test fixture intercepts the documented file:exists request.
        const request = args[0] as { filePath: string };
        return Promise.resolve(request.filePath === 'src/app.ts');
      }
      return invoke(channel, ...args);
    };
  });
  await page.getByRole('button', { name: 'Expand repository File link fixture', exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  const terminal = page.getByRole('tabpanel').locator('.xterm-screen').first();
  await expect(terminal).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  const box = await terminal.boundingBox();
  if (!box) throw new Error('Missing terminal');
  await page.mouse.move(box.x + 35, box.y + 25);
  await expect(page.getByText('/home/test-user/.zshrc', { exact: true })).toBeVisible();
  await page.keyboard.down('Control');
  await page.mouse.click(box.x + 35, box.y + 25);
  await page.keyboard.up('Control');
  await expect(page.getByRole('button', { name: 'Open in Editor', exact: true })).toBeDisabled();
  await expect(page.getByText('Outside this worktree', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('outside-worktree.png') });
  await page.getByRole('button', { name: 'Show in Explorer', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-revealed-path', '/home/test-user/.zshrc');
  await page.mouse.move(box.x + 45, box.y + 8);
  await expect(page.getByText('/tmp/file-link-fixture/src/app.ts', { exact: true })).toBeVisible();
  await page.keyboard.down('Control');
  await page.mouse.click(box.x + 45, box.y + 8);
  await page.keyboard.up('Control');
  await expect(page.getByRole('button', { name: 'Open in Editor', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Open in Editor', exact: true }).click();
  await expect(page.getByRole('tab', { name: /app.ts/ })).toBeVisible();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('opened-editor.png') });
});
