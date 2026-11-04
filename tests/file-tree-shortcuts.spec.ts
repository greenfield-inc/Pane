import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test('a selected tree item cannot intercept shortcuts in a diff tab', async ({ page, context }, testInfo) => {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const sessionId = 'tree-shortcuts';
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [{ id: 84, name: 'Keyboard scope', path: '/fixture', active: true, created_at: createdAt, updated_at: createdAt }],
    initialSessions: [{ id: sessionId, name: 'Tree shortcuts', projectId: 84, worktreePath: '/fixture', status: 'stopped', createdAt, output: [], jsonMessages: [], toolType: 'none' }],
    initialPanels: [
      { id: 'tree', sessionId, type: 'explorer', title: 'Files', state: { isActive: false }, metadata: { createdAt, lastActiveAt: createdAt, position: 0, permanent: true } },
      { id: 'diff-file', sessionId, type: 'editor', title: 'review.ts (All changes)', state: { isActive: true, customState: { filePath: 'review.ts', diff: { kind: 'scope', scope: { kind: 'session' } } } }, metadata: { createdAt, lastActiveAt: createdAt, position: 1 } },
    ],
    fileDiffs: { 'session:review.ts': { file: { path: 'review.ts', kind: 'modified', additions: 1, deletions: 1, isBinary: false }, status: 'changed', patch: 'diff --git a/review.ts b/review.ts\n--- a/review.ts\n+++ b/review.ts\n@@ -1 +1 @@\n-old text\n+Selected diff text\n' } },
    activeProjectId: 84,
    initialUiState: { expandedProjects: [84] },
  });
  await page.addInitScript(() => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = async (channel, ...args) => {
      if (channel === 'file:list') {
        // SAFETY: The public file:list IPC contract supplies a directory path.
        const request = args[0] as { path: string };
        const root = request.path === '';
        return { success: true, files: root ? [{ name: 'assets', path: 'assets', isDirectory: true }] : [] };
      }
      if (channel === 'file:delete' || channel === 'file:copy' || channel === 'file:move') {
        document.body.dataset.fileMutation = channel;
        return { success: true };
      }
      return invoke(channel, ...args);
    };
  });
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Tree shortcuts', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  const folder = page.getByRole('treeitem', { name: 'assets', exact: true }).first();
  await folder.click();
  await folder.focus();
  await page.keyboard.press('ControlOrMeta+c');
  const diffTab = page.getByRole('tab', { name: 'review.ts (All changes)', exact: true });
  await diffTab.click();
  const diffText = page.getByText('Selected diff text', { exact: true });
  await expect(diffText).toBeVisible();
  await diffTab.focus();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('Previous clipboard text'));
  await diffText.evaluate(element => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Selected diff text');
  await page.keyboard.press('ControlOrMeta+v');
  await page.keyboard.press('Delete');
  await page.keyboard.press('F2');
  expect(dialogs).toEqual([]);
  await expect(folder.locator('input')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveAttribute('data-file-mutation');
  await page.mouse.move(1000, 500);
  await page.screenshot({ path: testInfo.outputPath('diff-shortcuts-preserve-tree.png') });

  // Tree-owned shortcuts remain available after focus returns to the tree.
  await folder.focus();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.getByPlaceholder('Search files...')).toBeVisible();
  await folder.focus();
  await page.keyboard.press('Delete');
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain('trash?');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('body')).toHaveAttribute('data-file-mutation', 'file:copy');
});
