import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// Enter goes to the chat (D-328): with a chat tab on screen and focus on no
// control, Enter moves focus into its message box; opening a Pane with Enter
// from the sidebar lands there too. Enter in a field, a button or a terminal
// keeps its meaning.

const now = new Date(0).toISOString();
const project = { id: 78, name: 'Chat fixture', path: '/tmp/chat-fixture', active: true, created_at: now, updated_at: now };
const pane = (id: string, name: string, displayOrder: number) => ({
  id, name, worktreePath: `/tmp/chat-fixture/${id}`, prompt: '', status: 'stopped', createdAt: now, lastActivity: now,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder,
  isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
});
const sessions = [pane('chat-a', 'chat-pane', 0), pane('term-b', 'terminal-pane', 1)];
const terminal = (id: string, sessionId: string, title: string, position: number, isActive = false) => ({
  id, sessionId, type: 'terminal', title,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position },
});
// Each Pane's first terminal is its bottom dock; the tabs come after it.
const panels = [
  terminal('dock-a', 'chat-a', 'Terminal', 0),
  {
    id: 'chat', sessionId: 'chat-a', type: 'chat', title: 'Claude',
    state: { isActive: true, hasBeenViewed: true, customState: { agent: 'claude', launch: { kind: 'new' }, cwd: '/tmp/chat-fixture/chat-a', status: 'idle' } },
    metadata: { createdAt: now, lastActiveAt: now, position: 1 },
  },
  terminal('shell', 'chat-a', 'Shell', 2),
  terminal('dock-b', 'term-b', 'Terminal', 0),
  terminal('other', 'term-b', 'Work', 1, true),
];

async function openFixture(page: Page): Promise<void> {
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: sessions, initialPanels: panels, activeProjectId: project.id });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand project Chat fixture', exact: true }).click();
}

const messageBox = (page: Page) => page.getByRole('textbox', { name: 'Message Claude' });

test('Enter in the sidebar opens a Pane whose main tab is a chat and lands in its message box', async ({ page }, testInfo) => {
  await openFixture(page);
  // Start on the terminal Pane, so the chat Pane is not yet mounted when Enter opens it.
  await page.getByRole('button', { name: 'terminal-pane', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+0');
  await expect(page.getByRole('button', { name: 'terminal-pane', exact: true })).toBeFocused();
  // terminal-pane sorts above chat-pane.
  await page.keyboard.press('j');
  await expect(page.getByRole('button', { name: 'chat-pane', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('j-moves-the-sidebar-cursor.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'chat-pane', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(messageBox(page)).toBeFocused();
  await page.keyboard.type('hello');
  await expect(messageBox(page)).toHaveValue('hello');
  await page.screenshot({ path: testInfo.outputPath('enter-from-sidebar-lands-in-chat.png') });
});

test('Enter with focus on no control moves into the chat; Enter on a tab shows it; Enter on a button keeps its meaning', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: 'chat-pane', exact: true }).click();
  await expect(messageBox(page)).toBeVisible();

  // Focus on the page itself: Enter goes to the chat.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.keyboard.press('Enter');
  await expect(messageBox(page)).toBeFocused();

  // Focus on a scroll surface, as after a click opens the Pane: Enter goes to the chat too.
  await page.getByRole('region', { name: 'Commit history' }).focus();
  await page.keyboard.press('Enter');
  await expect(messageBox(page)).toBeFocused();

  // Enter on a tab that shows a chat goes on into its message box; Space only shows the tab.
  const chatTab = page.getByRole('tab', { name: /Claude/ }).first();
  const shellTab = page.getByRole('tab', { name: /Shell/ }).first();
  await shellTab.focus();
  await page.keyboard.press('Enter');
  await expect(messageBox(page)).toBeHidden();
  await expect(shellTab).toBeFocused();
  // Enter in a terminal is the terminal's.
  const shell = page.locator('[data-panel-group-id] .xterm-helper-textarea:visible');
  await shell.focus();
  await page.keyboard.press('Enter');
  await expect(shell).toBeFocused();
  await chatTab.focus();
  await page.keyboard.press('Space');
  await expect(messageBox(page)).toBeVisible();
  await expect(chatTab).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(messageBox(page)).toBeFocused();

  // Enter on a sidebar button keeps its meaning: it collapses the project and the cursor stays.
  await page.keyboard.press('ControlOrMeta+0');
  await page.getByRole('button', { name: 'Collapse project Chat fixture', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Expand project Chat fixture', exact: true })).toBeFocused();
  await expect(messageBox(page)).not.toBeFocused();
});
