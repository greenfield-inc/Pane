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

// Two splits, each able to show a chat: Enter must stay in the split it was pressed in.
const splitProject = { id: 79, name: 'Split fixture', path: '/tmp/split-fixture', active: true, created_at: now, updated_at: now };
const splitPanel = (id: string, type: 'terminal' | 'chat', title: string, position: number, isActive = false) => ({
  id, sessionId: 'sp', type, title,
  state: {
    isActive, hasBeenViewed: true,
    customState: type === 'chat'
      ? { agent: 'claude', launch: { kind: 'new' }, cwd: '/tmp/split-fixture/sp', status: 'idle' }
      : { isInitialized: false },
  },
  metadata: { createdAt: now, lastActiveAt: now, position },
});
const splitPanels = [
  splitPanel('dock', 'terminal', 'Terminal', 0),
  splitPanel('chat-left', 'chat', 'Left chat', 1, true),
  splitPanel('shell-right', 'terminal', 'Right shell', 2),
  splitPanel('chat-right', 'chat', 'Right chat', 3),
];
const splitLayout = {
  version: 1,
  focusedGroupId: 'g-right',
  root: {
    type: 'split', id: 's-root', direction: 'row', sizes: [1, 1],
    children: [
      { type: 'group', id: 'g-left', panelIds: ['chat-left'], activePanelId: 'chat-left' },
      { type: 'group', id: 'g-right', panelIds: ['shell-right', 'chat-right'], activePanelId: 'shell-right' },
    ],
  },
};

test('Enter stays in its own split: a chat tab opens into its own message box, never the other split\'s chat', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [splitProject],
    initialSessions: [{ ...pane('sp', 'split-pane', 0), worktreePath: '/tmp/split-fixture/sp', projectId: splitProject.id }],
    initialPanels: splitPanels, initialLayout: splitLayout, activeProjectId: splitProject.id,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand project Split fixture', exact: true }).click();
  await page.getByRole('button', { name: 'split-pane', exact: true }).click();
  const left = page.locator('[data-panel-group-id="g-left"] [data-chat-composer]');
  const right = page.locator('[data-panel-group-id="g-right"] [data-chat-composer]');
  const rightSplit = page.locator('[data-panel-group-id="g-right"]');
  await expect(left).toBeVisible();
  await expect(page.locator('[data-panel-group-id="g-right"] .xterm-helper-textarea')).toHaveCount(1);

  // Focus on the right split, which shows a shell: Enter does not jump into the left split's chat.
  await rightSplit.evaluate((element: HTMLElement) => { element.setAttribute('tabindex', '-1'); element.focus(); });
  await expect(rightSplit).toHaveAttribute('data-group-focused', 'true');
  await page.keyboard.press('Enter');
  await expect(left).not.toBeFocused();
  await expect(rightSplit).toBeFocused();

  // Enter in the right split's terminal is the terminal's, with a chat on screen in the other split.
  const shell = page.locator('[data-panel-group-id="g-right"] .xterm-helper-textarea');
  await shell.focus();
  await page.keyboard.press('Enter');
  await expect(shell).toBeFocused();

  // Enter on the right split's chat tab lands in the right chat, and what is typed goes there.
  await page.getByRole('tab', { name: 'Right chat', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(right).toBeFocused();
  await page.keyboard.type('xyz');
  await expect(right).toHaveValue('xyz');
  await expect(left).toHaveValue('');
});
