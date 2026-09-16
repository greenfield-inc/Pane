import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { KEYBOARD_SHORTCUT_CATALOG } from '../shared/constants/keyboardShortcuts';
import { installElectronApiMock } from './electronApiMock';
import { expectNoAxeViolations } from './axeTest';

type ShortcutsMock = {
  getConfigUpdates: () => JsonObject[];
  failNextConfigUpdate: (error: string) => void;
};

const project = {
  id: 620,
  name: 'Shortcut settings fixture',
  path: '/tmp/shortcut-settings-fixture',
  active: true,
  environment: 'linux',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'shortcut-settings-session',
  name: 'Shortcut settings pane',
  worktreePath: `${project.path}/wt`,
  prompt: 'Verify shortcut settings',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};

const panels = ['Bottom Terminal', 'Tab Terminal'].map((title, index) => ({
  id: `shortcut-terminal-${index}`,
  sessionId: session.id,
  type: 'terminal',
  title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(), position: index, permanent: index === 0 },
}));
const terminalStates = Object.fromEntries(panels.map((panel) => [panel.id, { scrollbackBuffer: 'ready\r\n' }]));

const REFERENCE_ROW_COUNT = 7;
const SNIPPET = { id: 'snip', label: 'Lint snippet', key: 'l', text: 'pnpm lint', enabled: true };
const CUSTOM = { name: 'Deploy', command: 'pnpm deploy' };

async function mock(page: Page, initialConfig: JsonObject = {}, options: Parameters<typeof installElectronApiMock>[1] = {}) {
  await installElectronApiMock(page, {
    initialConfig: { terminalShortcuts: [SNIPPET], customCommands: [CUSTOM], ...initialConfig },
    ...options,
  });
}

async function openShortcuts(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  const map = page.locator('[data-setting-id="keyboard-shortcut-map"]');
  await expect(map).toBeVisible();
  return map;
}

async function configUpdates(page: Page): Promise<JsonObject[]> {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (window as typeof window & { __paneTestElectronMock: ShortcutsMock }).__paneTestElectronMock.getConfigUpdates());
}

const expectedRowCount = KEYBOARD_SHORTCUT_CATALOG.filter((entry) => !entry.dynamicSlot).length + 1 /* configured custom slot */ + 1 /* snippet */;

test('shows the complete inventory regardless of the current view, with an axe-clean page', async ({ page }) => {
  await mock(page, { keyboardShortcutOverrides: { 'open-settings': 'nope', 'toggle-sidebar': null } });
  const map = await openShortcuts(page);

  await expect(map.locator('[data-shortcut-id]')).toHaveCount(expectedRowCount);
  await expect(map.getByRole('rowgroup', { name: 'Terminal and native shortcuts' }).getByRole('row')).toHaveCount(REFERENCE_ROW_COUNT + 1);
  await expect(map.locator('[data-shortcut-id="open-settings"]').getByText('Invalid — using default')).toBeVisible();
  // Recorder button and state tag both read "Unassigned".
  await expect(map.locator('[data-shortcut-id="toggle-sidebar"]').getByText('Unassigned', { exact: true })).toHaveCount(2);
  await expect(map.locator('[data-shortcut-id="add-tool-custom-0"]')).toContainText('Add Deploy');
  await expect(map.locator('[data-shortcut-id="terminal-shortcut-snip"]')).toContainText('Lint snippet');
  await expect(map.locator('table')).toHaveCount(1);
  await expect(map.locator('thead').getByRole('columnheader')).toHaveCount(5);
  await expectNoAxeViolations(page);
  await page.getByTestId('settings-content').evaluate(element => {
    const search = element.querySelector('[aria-label="Search shortcuts"]');
    if (search) element.scrollTop += search.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
  });
  await page.screenshot({ path: 'tmp/configurable-keybindings/closeout-shortcuts.png' });

  await map.getByRole('textbox', { name: 'Search shortcuts' }).fill('codex');
  await expect(map.locator('[data-shortcut-id]')).toHaveCount(1);
  await expect(map.locator('[data-shortcut-id="add-tool-terminal-codex"]')).toBeVisible();
  await expect(map.getByRole('rowgroup', { name: 'Terminal and native shortcuts' })).toHaveCount(0);
  await map.getByRole('textbox', { name: 'Search shortcuts' }).fill('copy selection');
  await expect(map.locator('[data-shortcut-id]')).toHaveCount(0);
  await expect(map.getByRole('rowgroup', { name: 'Terminal and native shortcuts' }).getByRole('row')).toHaveCount(2);
});

test('shows the same inventory from a Project view with a WSL project on a Windows host', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' });
  });
  await mock(page, {}, {
    platform: 'win32',
    initialProjects: [{ ...project, environment: 'wsl' }],
    initialSessions: [session],
    initialPanels: panels,
    initialTerminalStates: terminalStates,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Shortcut settings fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect(page.getByRole('tabpanel').locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Control+Alt+/');
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  const map = page.locator('[data-setting-id="keyboard-shortcut-map"]');

  await expect(map.locator('[data-shortcut-id]')).toHaveCount(expectedRowCount);
  // The active project is WSL, so Cursor is available even though the host is Windows.
  await expect(map.locator('[data-shortcut-id="add-tool-terminal-cursor"]').getByText('Unavailable on this platform')).toHaveCount(0);
});

test('marks Cursor unavailable but still editable on a native Windows host', async ({ page }) => {
  await mock(page, {}, { platform: 'win32' });
  const map = await openShortcuts(page);
  const cursor = map.locator('[data-shortcut-id="add-tool-terminal-cursor"]');
  await expect(cursor.getByText('Unavailable on this platform')).toBeVisible();
  await expect(cursor.getByRole('button', { name: 'Record shortcut for Add Cursor' })).toBeEnabled();

  // A remap onto Cursor's chord still conflicts: bindings are validated globally.
  const push = map.locator('[data-shortcut-id="git-push"]');
  await push.getByRole('button', { name: 'Record shortcut for Git: Push' }).click();
  await page.keyboard.press('Control+Alt+5');
  await expect(push.getByRole('alert')).toContainText('is also bound to Add Cursor');
  await expect(map.getByRole('button', { name: 'Apply' })).toBeDisabled();
});

test('records with the keyboard only, cancels with Escape without closing Settings, and unassigns', async ({ page }) => {
  await mock(page);
  const map = await openShortcuts(page);
  const row = map.locator('[data-shortcut-id="add-tool-terminal-claude"]');
  const record = row.getByRole('button', { name: 'Record shortcut for Add Claude Code' });

  await record.focus();
  await page.keyboard.press('Enter');
  await expect(row.getByRole('button', { name: /Recording shortcut for Add Claude Code/ })).toBeVisible();
  await page.keyboard.press('Shift');
  await expect(row.getByText('Press a key with the modifier')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row.getByText('Recording cancelled')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  await expect(record).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.press('x');
  await expect(row.getByText(/must include Ctrl/)).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(row.getByText('Unassigned', { exact: true })).toHaveCount(2);
  await expect(map.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await map.getByRole('button', { name: 'Apply' }).click();
  expect(await configUpdates(page)).toContainEqual({ keyboardShortcutOverrides: { 'add-tool-terminal-claude': null } });
});

test('names both owners for a snippet conflict and a custom-command conflict, then resets', async ({ page }) => {
  await mock(page);
  const map = await openShortcuts(page);
  const apply = map.getByRole('button', { name: 'Apply' });
  const codex = map.locator('[data-shortcut-id="add-tool-terminal-codex"]');

  await codex.getByRole('button', { name: 'Record shortcut for Add Codex' }).click();
  await page.keyboard.press('Control+Alt+L');
  await expect(codex.getByRole('alert')).toContainText('is also bound to Lint snippet (edit in Terminal snippets below)');
  await expect(map.locator('[data-shortcut-id="terminal-shortcut-snip"]').getByRole('alert')).toContainText('is also bound to Add Codex');
  await expect(apply).toBeDisabled();

  await codex.getByRole('button', { name: 'Record shortcut for Add Codex' }).click();
  await page.keyboard.press('Control+Alt+6');
  await expect(codex.getByRole('alert')).toContainText('is also bound to Add Deploy');
  await expect(apply).toBeDisabled();

  await codex.getByRole('button', { name: 'Reset Add Codex to default' }).click();
  await expect(codex.getByRole('alert')).toHaveCount(0);
  await expect(apply).toBeDisabled();
});

test('recording a row default removes the override instead of storing it', async ({ page }) => {
  await mock(page, { keyboardShortcutOverrides: { 'add-tool-terminal-claude': 'mod+alt+y' } });
  const map = await openShortcuts(page);
  const row = map.locator('[data-shortcut-id="add-tool-terminal-claude"]');
  await expect(row.getByText('Customized')).toBeVisible();
  await row.getByRole('button', { name: 'Record shortcut for Add Claude Code' }).click();
  await page.keyboard.press('Control+Alt+3');
  await expect(row.getByText('Customized')).toHaveCount(0);
  await map.getByRole('button', { name: 'Apply' }).click();
  expect(await configUpdates(page)).toContainEqual({ keyboardShortcutOverrides: {} });
});

test('a failed Apply keeps the draft, reports the error, and stays retryable', async ({ page }) => {
  await mock(page);
  const map = await openShortcuts(page);
  const row = map.locator('[data-shortcut-id="git-pull"]');
  await row.getByRole('button', { name: 'Record shortcut for Git: Pull' }).click();
  await page.keyboard.press('Control+Alt+J');
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  await page.evaluate(() => (window as typeof window & { __paneTestElectronMock: ShortcutsMock }).__paneTestElectronMock.failNextConfigUpdate('disk full'));
  await map.getByRole('button', { name: 'Apply' }).click();
  await expect(map.getByText('disk full')).toBeVisible();
  await expect(row.getByText('Customized')).toBeVisible();
  await expect(map.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await map.getByRole('button', { name: 'Apply' }).click();
  await expect(map.getByText('Saved', { exact: true })).toBeVisible();
  expect(await configUpdates(page)).toContainEqual({ keyboardShortcutOverrides: { 'git-pull': 'mod+alt+j' } });
});

test('Help and the Add Tool menu show the effective chord after a remap and after reset', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => 'Linux x86_64' });
  });
  await mock(page, { keyboardShortcutOverrides: { 'add-tool-terminal-codex': 'mod+alt+y' } }, {
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialTerminalStates: terminalStates,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Shortcut settings fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect(page.getByRole('tabpanel').locator('.xterm-screen').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('tabpanel').getByRole('status', { name: 'Loading terminal' })).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: 'Add tool' }).first().click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Codex/ })).toContainText('Ctrl+Alt+Y');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Alt+/');
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  const map = page.locator('[data-setting-id="keyboard-shortcut-map"]');
  await map.getByRole('button', { name: 'Reset all to defaults' }).click();
  await page.getByRole('dialog', { name: 'Reset all key bindings?' }).getByRole('button', { name: 'Reset all' }).click();
  await map.getByRole('button', { name: 'Apply' }).click();
  await expect(map.getByText('Saved', { exact: true })).toBeVisible();
  expect(await configUpdates(page)).toContainEqual({ keyboardShortcutOverrides: {} });

  await page.getByRole('button', { name: 'View all Pane keyboard shortcuts' }).click();
  const help = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await expect(help).toBeVisible();
  await expect(help.getByText('Add Codex')).toBeVisible();
  await expect(help.locator('kbd', { hasText: /^Y$/ })).toHaveCount(0);
  await expect(help.getByText('Send Input / Continue Conversation')).toBeVisible();
});


test('remapped continuous scrolling stops when the remapped key is released', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mock(page, { keyboardShortcutOverrides: { 'scroll-focused-surface-down': 'alt+F6' } });
  await openShortcuts(page);
  const content = page.getByTestId('settings-content');
  await content.focus();
  const scrollTop = () => content.evaluate(element => element.scrollTop);
  const before = await scrollTop();
  await page.keyboard.down('Alt');
  await page.keyboard.down('F6');
  await expect.poll(scrollTop).toBeGreaterThan(before + 2);
  await page.keyboard.up('F6');
  const released = await scrollTop();
  await page.waitForTimeout(250);
  expect(await scrollTop()).toBe(released);
  await page.keyboard.up('Alt');
});


test('keeps the shortcut table inside the Settings viewport at narrow width', async ({ page }) => {
  await mock(page);
  const map = await openShortcuts(page);
  await page.setViewportSize({ width: 520, height: 800 });
  await map.getByRole('textbox', { name: 'Search shortcuts' }).fill('claude');
  const content = page.getByTestId('settings-content');
  expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByTestId('settings-content').evaluate(element => {
    const search = element.querySelector('[aria-label="Search shortcuts"]');
    if (search) element.scrollTop += search.getBoundingClientRect().top - element.getBoundingClientRect().top - 12;
  });
  await expectNoAxeViolations(page);
  await page.screenshot({ path: 'tmp/configurable-keybindings/closeout-shortcuts-narrow.png' });
});
