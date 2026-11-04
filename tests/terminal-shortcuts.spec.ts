import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 381, name: 'Terminal input fixture', path: '/tmp/terminal-input-fixture',
  active: true, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
};
const session = {
  id: 'terminal-input-session', name: 'Terminal input pane', worktreePath: project.path,
  prompt: '', status: 'stopped', createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(), output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false,
  toolType: 'none', archived: false,
};
const panels = ['Bottom Terminal', 'Input Terminal'].map((title, index) => ({
  id: `input-terminal-${index}`, sessionId: session.id, type: 'terminal', title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: {
    createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(),
    position: index, permanent: index === 0,
  },
}));

test('terminal shortcut inserts literal text into the focused terminal without changing the clipboard', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], initialPanels: panels,
    activeProjectId: project.id,
    initialConfig: { terminalShortcuts: [{ id: 'literal', label: 'Insert literal', key: 'j', text: 'echo "$HOME"\nnext line', enabled: true }] },
  });
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }));
  await page.goto('/');
  await page.evaluate(() => {
    document.body.dataset.clipboard = 'keep my clipboard';
    document.body.dataset.shortcutInputs = '[]';
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'clipboard:paste') document.body.dataset.clipboard = String(args[0]);
      if (channel === 'terminal:input') document.body.dataset.shortcutInputs = JSON.stringify(args);
      return invoke(channel, ...args);
    };
    if (window.electron) window.electron.invoke = window.electronAPI.invoke;
  });
  await page.getByRole('button', { name: 'Expand repository Terminal input fixture', exact: true }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  const terminal = page.getByRole('tabpanel');
  const input = terminal.locator('.xterm-helper-textarea').first();
  await expect(input).toBeAttached();
  await expect(terminal.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await input.focus();
  await page.keyboard.press('Meta+Alt+j');
  await expect.soft(page.locator('body')).toHaveAttribute('data-clipboard', 'keep my clipboard');
  await expect(page.locator('body')).toHaveAttribute('data-shortcut-inputs', JSON.stringify(['input-terminal-1', 'echo "$HOME"\nnext line']));
  await expect(page.locator('body')).toHaveAttribute('data-clipboard', 'keep my clipboard');
  await page.screenshot({ path: testInfo.outputPath('shortcut-terminal.png') });

  // A search field must not redirect shortcut text into a previously active terminal.
  await page.evaluate(() => {
    document.body.dataset.shortcutInputs = '[]';
    const field = document.createElement('input');
    field.setAttribute('aria-label', 'Unrelated text field');
    document.body.append(field);
    field.focus();
  });
  await page.keyboard.press('Meta+Alt+j');
  await expect(page.locator('body')).toHaveAttribute('data-shortcut-inputs', '[]');
  await expect(page.locator('body')).toHaveAttribute('data-clipboard', 'keep my clipboard');
});
