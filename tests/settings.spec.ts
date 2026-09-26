import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

type SettingsMock = {
  getConfig: () => JsonObject;
  getConfigUpdates: () => JsonObject[];
  getListenerCount: (channel: string) => number;
  getPreferenceWrites: () => Array<{ key: string; value: string }>;
  failNextConfigUpdate: (error: string) => void;
  failNextPreferenceSet: (error: string) => void;
  setConfigGetFailures: (count: number) => void;
  getBackgroundColorWrites: () => Array<{ theme: string; color: string }>;
};

async function bootSettings(page: Page, options: Parameters<typeof installElectronApiMock>[1] = {}) {
  await installElectronApiMock(page, options);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });

  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();

  const settingsButton = page.getByRole('button', { name: 'Settings' }).first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
  return settingsButton;
}

test.describe('Settings', () => {
  test('pairs system palettes, preserves fixed selection, follows the OS, and rolls back failures', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await bootSettings(page);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const mode = page.getByRole('radiogroup', { name: 'Appearance mode' });
    await expect(mode.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('combobox', { name: 'Light palette' })).toHaveText('Light (rounded)');
    await expect(page.getByRole('combobox', { name: 'Dark palette' })).toHaveText('Dark (sharp)');
    await expect(page.getByText('Active now')).toBeVisible();

    await page.getByRole('combobox', { name: 'Light palette' }).click();
    await expect(page.getByRole('option', { name: /^Forge/ })).toHaveCount(0);
    await page.getByRole('option', { name: /^Folio/ }).click();
    await expect(page.locator('html')).toHaveClass(/folio/);
    await page.getByRole('combobox', { name: 'Dark palette' }).click();
    await expect(page.getByRole('option', { name: /^Folio/ })).toHaveCount(0);
    await page.getByRole('option', { name: /^Forge/ }).click();
    await expect(page.locator('html')).toHaveClass(/folio/);

    await mode.getByRole('radio', { name: 'Fixed' }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveText('Light (rounded)');
    await page.getByRole('combobox', { name: 'Theme' }).click();
    await page.getByRole('option', { name: /^Night Owl(?! \(OLED\))/ }).click();
    await expect(page.locator('html')).toHaveClass(/night-owl/);
    await mode.getByRole('radio', { name: 'System' }).click();
    await expect(page.locator('html')).toHaveClass(/folio/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/forge/);

    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock.failNextConfigUpdate('appearance save rejected');
    });
    await page.getByRole('combobox', { name: 'Dark palette' }).click();
    await page.getByRole('option', { name: /^Abyss/ }).click();
    await expect(page.getByRole('alert')).toContainText('appearance save rejected');
    await expect(page.locator('html')).toHaveClass(/forge/);
    await expect.poll(() => page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      return (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock.getBackgroundColorWrites().at(-1)?.theme;
    })).toBe('forge');
    const config = await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      return (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock.getConfig();
    });
    expect(config).toMatchObject({ theme: 'night-owl', systemLightTheme: 'folio', systemDarkTheme: 'forge' });
  });

  test('terminal font updates the live xterm only', async ({ page }) => {
    const now = new Date(0).toISOString();
    const project = {
      id: 913,
      name: 'Terminal font fixture',
      path: '/tmp/terminal-font-fixture',
      active: true,
      created_at: now,
      updated_at: now,
    };
    const session = {
      id: 'terminal-font-session',
      name: 'Live terminal font',
      worktreePath: project.path,
      prompt: '',
      status: 'stopped',
      createdAt: now,
      lastActivity: now,
      output: [],
      jsonMessages: [],
      isRunning: false,
      permissionMode: 'ignore',
      projectId: project.id,
      displayOrder: 0,
      isFavorite: false,
      toolType: 'none',
      archived: false,
      gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
    };
    const dockPanel = {
      id: 'terminal-font-dock',
      sessionId: session.id,
      type: 'terminal',
      title: 'Terminal',
      state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } },
      metadata: { createdAt: now, lastActiveAt: now, position: 0, permanent: true },
    };
    const panel = {
      id: 'terminal-font-panel',
      sessionId: session.id,
      type: 'terminal',
      title: 'Shell',
      state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: true } },
      metadata: { createdAt: now, lastActiveAt: now, position: 1, permanent: false },
    };

    await installElectronApiMock(page, {
      platform: 'darwin',
      initialProjects: [project],
      initialSessions: [session],
      initialPanels: [dockPanel, panel],
      initialTerminalStates: { [panel.id]: { scrollbackBuffer: 'ready\r\n' } },
      activeProjectId: project.id,
    });
    // The default terminal font ships with the app: it must load with no network.
    await page.route(url => !['localhost', '127.0.0.1'].includes(url.hostname), route => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: /^Expand repository Terminal font fixture$/ }).click();
    await page.getByRole('button', { name: session.name, exact: true }).click();
    await expect(page.locator('.xterm-screen')).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => [...document.fonts].some(
      font => font.family.replace(/["']/g, '') === 'Geist Mono' && font.status === 'loaded',
    ))).toBe(true);

    const host = page.locator('[data-terminal-font]').first();
    await expect(host).toHaveAttribute('data-terminal-font', '"Geist Mono", "Symbols Nerd Font Mono", monospace');
    await expect.poll(() => page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      return mock.getListenerCount('config:terminal-font-updated');
    })).toBeGreaterThan(0);
    const bodyFont = await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const fontInput = page.getByRole('textbox', { name: 'Custom terminal font family' });
    await fontInput.fill('Menlo');
    await fontInput.blur();

    await expect.poll(() => host.getAttribute('data-terminal-font')).toBe('"Menlo", "Symbols Nerd Font Mono", monospace');
    await expect(page.locator('body')).toHaveCSS('font-family', bodyFont);
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const updates = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfigUpdates());
    expect(updates.at(-1)).toEqual({ terminalFontFamily: 'Menlo' });
  });

  test('hides unsupported Cursor as a default Pane Chat agent on Windows', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'Win32' });
    });
    await bootSettings(page, { platform: 'win32' });

    await page.getByRole('button', { name: 'AI & Agents', exact: true }).click();
    const agentChoices = page.getByRole('radiogroup', { name: 'Default Pane Chat agent' });
    await expect(agentChoices.getByRole('radio')).toHaveCount(2);
    await expect(agentChoices.getByRole('radio', { name: 'Cursor' })).toHaveCount(0);
  });

  test('mounts every category from the settings catalog', async ({ page }) => {
    await bootSettings(page);
    const categories = [
      'General',
      'Appearance',
      'Terminal',
      'AI & Agents',
      'Worktrees & Git',
      'Notifications',
      'Remote Access',
      'Integrations',
      'Shortcuts',
      'Privacy',
      'Advanced',
    ];
    const navigation = page.getByRole('navigation', { name: 'Settings categories' });

    for (const category of categories) {
      await navigation.getByRole('button', { name: category, exact: true }).click();
      await expect(page.getByRole('heading', { name: category, exact: true })).toBeVisible();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    }
  });

  test('shows a loading state while configuration is pending', async ({ page }) => {
    await bootSettings(page, { configReadDelayMs: 5_000 });
    await expect(page.getByText('Loading settings')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('navigates categories and keeps the last category for the renderer session', async ({ page }) => {
    const opener = await bootSettings(page);
    const dialog = page.getByRole('dialog', { name: 'Pane Settings' });
    await page.waitForTimeout(250);
    const initialHeight = (await dialog.boundingBox())?.height;

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Settings categories' }).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-current', 'page');
    const terminalHeight = (await dialog.boundingBox())?.height;
    expect(Math.abs((terminalHeight ?? 0) - (initialHeight ?? 0))).toBeLessThan(1);
    expect(initialHeight).toBeGreaterThanOrEqual(560);
    expect(initialHeight).toBeLessThanOrEqual(760);
    expect(await page.getByTestId('settings-content').evaluate(
      (content) => content.scrollHeight > content.clientHeight,
    )).toBe(true);
    await page.screenshot({ path: 'test-results/settings-normal.png' });

    await page.getByRole('button', { name: 'Close modal' }).click();
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
  });

  test('opens the terminal shortcut editor through the typed hotkey target', async ({ page }) => {
    await installElectronApiMock(page);
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('Control+Alt+/');

    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible();
    await expect(page.locator('[data-setting-id="terminal-shortcuts"]')).toBeFocused();
  });

  test('disables Pane keyboard shortcut interception from shortcut settings', async ({ page }) => {
    await bootSettings(page);
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();

    const toggle = page.getByRole('switch', { name: 'Enable Pane keyboard shortcuts' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const updates = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfigUpdates());
    expect(updates).toContainEqual({ keyboardShortcutsEnabled: false });
  });

  test('configures the Command Palette exception and opens the shortcut reference', async ({ page }) => {
    await bootSettings(page, {
      initialConfig: { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true },
    });
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();

    await expect(page.getByText("When disabled, Pane shortcuts won't work, but native terminal and embedded app shortcuts will. The Command Palette shortcut can remain enabled below.")).toBeVisible();
    const paletteToggle = page.getByRole('switch', { name: 'Keep Command Palette shortcut enabled' });
    await expect(paletteToggle).toHaveAttribute('aria-checked', 'true');
    await paletteToggle.click();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const updates = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfigUpdates());
    expect(updates).toContainEqual({ commandPaletteShortcutEnabled: false });

    await page.getByRole('button', { name: 'View all Pane keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await expect(page.getByText('Open Command Palette')).toBeVisible();
  });

  test('records, blocks conflicting, and resets global key bindings', async ({ page }) => {
    await bootSettings(page, {
      initialConfig: { terminalShortcuts: [{ id: 'snip', label: 'Lint snippet', key: 'l', text: 'pnpm lint', enabled: true }] },
    });
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
    const map = page.locator('[data-setting-id="keyboard-shortcut-map"]');
    const claudeRow = map.locator('[data-shortcut-id="add-tool-terminal-claude"]');
    const apply = map.getByRole('button', { name: 'Apply' });
    await expect(apply).toBeDisabled();

    // A chord already used by an enabled snippet is an active conflict.
    await claudeRow.getByRole('button', { name: 'Record shortcut for Add Claude Code' }).click();
    await page.keyboard.press('Control+Alt+L');
    await expect(claudeRow.getByRole('alert')).toContainText('is also bound to Lint snippet');
    await expect(apply).toBeDisabled();
    await expect(map.getByText('Resolve conflicts to apply.')).toBeVisible();

    // A terminal-reserved chord is refused with live text and recording stays armed.
    await claudeRow.getByRole('button', { name: 'Record shortcut for Add Claude Code' }).click();
    await page.keyboard.press('Control+Alt+F');
    await expect(claudeRow.getByRole('status')).toContainText('Reserved by the terminal');
    await page.keyboard.press('Control+Alt+Y');
    await expect(claudeRow.getByRole('alert')).toHaveCount(0);
    await expect(claudeRow.getByText('Customized')).toBeVisible();
    await expect(apply).toBeEnabled();
    await apply.click();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const updates = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfigUpdates());
    expect(updates).toContainEqual({ keyboardShortcutOverrides: { 'add-tool-terminal-claude': 'mod+alt+y' } });

    await map.getByRole('button', { name: 'Reset all to defaults' }).click();
    await page.getByRole('dialog', { name: 'Reset all key bindings?' }).getByRole('button', { name: 'Reset all' }).click();
    await expect(claudeRow.getByText('Customized')).toHaveCount(0);
  });

  test('shows the effective remapped chord in the shortcut reference', async ({ page }) => {
    await bootSettings(page, {
      initialConfig: { keyboardShortcutOverrides: { 'add-tool-terminal-codex': 'mod+alt+y', 'toggle-sidebar': null } },
    });
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
    await page.getByRole('button', { name: 'View all Pane keyboard shortcuts' }).click();
    const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Add Codex')).toBeVisible();
    await expect(dialog.locator('kbd', { hasText: 'Y' })).toHaveCount(1);
    await expect(dialog.getByText('unassigned')).toHaveCount(1);
    await expect(dialog.getByText('Send Input / Continue Conversation')).toBeVisible();
  });

  test('guards the shortcut reference when snippet edits are dirty', async ({ page }) => {
    await bootSettings(page);
    await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
    await page.getByRole('button', { name: 'Add Shortcut' }).click();
    await page.getByRole('button', { name: 'View all Pane keyboard shortcuts' }).click();

    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();

    await page.getByRole('button', { name: 'View all Pane keyboard shortcuts' }).click();
    await confirm.getByRole('button', { name: 'Discard Changes' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeVisible();
  });

  test('persists immediate config and database preferences through their owners', async ({ page }) => {
    await bootSettings(page, { initialConfig: { autoCheckUpdates: true } });

    await page.getByRole('switch', { name: 'Check for updates automatically' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Single row' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: 'Two rows' }).click();
    await expect(page.getByRole('radio', { name: 'Two rows' })).toHaveAttribute('aria-checked', 'true');

    const writes = await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      return { config: mock.getConfigUpdates(), preferences: mock.getPreferenceWrites() };
    });
    expect(writes.config).toContainEqual({ autoCheckUpdates: false });
    expect(writes.preferences).toContainEqual({ key: 'sidebar_pane_row_layout', value: 'two-row' });
  });

  test('persists the keep-awake toggle to config', async ({ page }) => {
    await bootSettings(page, { initialConfig: { keepAwakeWhileSessionsActive: true } });

    await page.getByRole('switch', { name: 'Keep computer awake while sessions are active' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const updates = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfigUpdates());
    expect(updates).toContainEqual({ keepAwakeWhileSessionsActive: false });
  });

  test('announces a failed save and restores the authoritative value', async ({ page }) => {
    await bootSettings(page, { initialConfig: { autoCheckUpdates: true } });
    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      mock.failNextConfigUpdate('Disk is read-only');
    });

    const toggle = page.getByRole('switch', { name: 'Check for updates automatically' });
    await toggle.click();

    await expect(page.getByRole('alert')).toContainText('Disk is read-only');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const config = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfig());
    expect(config.autoCheckUpdates).toBe(true);
  });

  test('recovers from config-load failure and preference-write failure', async ({ page }) => {
    await bootSettings(page, { configGetFailures: 100 });
    await expect(page.getByRole('alert')).toContainText('Mock config read failed');
    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      mock.setConfigGetFailures(0);
    });
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.evaluate(() => {
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      const mock = (window as typeof window & { __paneTestElectronMock: SettingsMock }).__paneTestElectronMock;
      mock.failNextPreferenceSet('Preference database is read-only');
    });
    await page.getByRole('radio', { name: 'Two rows' }).click();
    await expect(page.getByRole('alert')).toContainText('Preference database is read-only');
    await expect(page.getByRole('radio', { name: 'Single row' })).toHaveAttribute('aria-checked', 'true');
  });

  test('applies a staged worktree editor without closing settings', async ({ page }) => {
    await bootSettings(page);
    await page.getByRole('button', { name: 'Worktrees & Git', exact: true }).click();
    await page.getByRole('button', { name: 'Add Entry' }).click();
    await page.getByPlaceholder('e.g. .env').last().fill('.env.local');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();

    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const updates = await page.evaluate(() => (
      window as typeof window & { __paneTestElectronMock: SettingsMock }
    ).__paneTestElectronMock.getConfigUpdates());
    expect(updates.at(-1)?.worktreeFileSync).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.env.local', enabled: true }),
    ]));
  });

  test('guards category navigation when a staged form is dirty', async ({ page }) => {
    await bootSettings(page);

    await page.getByRole('button', { name: 'Worktrees & Git', exact: true }).click();
    await page.getByRole('button', { name: 'Add Entry' }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();

    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('heading', { name: 'Worktrees & Git' })).toBeVisible();

    await page.getByRole('button', { name: 'Close modal' }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Stay' }).click();

    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await confirm.getByRole('button', { name: 'Discard Changes' }).click();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  });

  test('discards remote subview drafts and rebaselines a completed host setup', async ({ page }) => {
    await bootSettings(page);
    const content = page.getByTestId('settings-content');

    await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
    await content.getByRole('button', { name: 'Advanced', exact: true }).click();
    await page.getByLabel('Connection Label', { exact: true }).fill('Discard this label');
    await page.getByRole('button', { name: 'Back to Remote Access' }).click();
    await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard Changes' }).click();

    await content.getByRole('button', { name: 'Advanced', exact: true }).click();
    await expect(page.getByLabel('Connection Label', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Back to Remote Access' }).click();

    await content.getByRole('button', { name: 'Set Up Host' }).click();
    await page.getByLabel('This Machine Label').fill('Office host');
    await page.getByRole('button', { name: 'Create Connection Code' }).click();
    await expect(page.getByText('Remote host configured and connection code created.')).toBeVisible();
    await page.getByRole('button', { name: 'Back to Remote Access' }).click();
    await expect(page.getByRole('heading', { name: 'Remote Access' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toHaveCount(0);
  });

  test('uses the category selector without horizontal overflow at narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 760 });
    await bootSettings(page);

    await expect(page.getByRole('navigation', { name: 'Settings categories' })).toBeHidden();
    const categorySelect = page.getByRole('combobox', { name: 'Settings category' });
    await categorySelect.click();
    await page.getByRole('option', { name: 'Terminal' }).click();
    await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();

    const overflows = await page.getByRole('dialog', { name: 'Pane Settings' }).evaluate(
      (dialog) => dialog.scrollWidth > dialog.clientWidth + 1,
    );
    expect(overflows).toBe(false);
    await page.screenshot({ path: 'test-results/settings-narrow.png' });
  });

  test('centers the dialog in the window', async ({ page }) => {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 640, height: 760 }]) {
      await page.setViewportSize(viewport);
      await bootSettings(page);

      const panel = page.getByRole('dialog', { name: 'Pane Settings' }).locator(':scope > div').first();
      const box = await panel.boundingBox();
      if (!box) throw new Error('Settings dialog has no bounding box');
      expect(box.x).toBeCloseTo((viewport.width - box.width) / 2, 0);
      expect(box.y).toBeCloseTo((viewport.height - box.height) / 2, 0);

      await page.getByRole('button', { name: 'Close modal' }).click();
    }
  });

  test('shows Windows shell controls only when the platform supports them', async ({ page }) => {
    await bootSettings(page, {
      platform: 'win32',
      availableShells: [{ id: 'pwsh', name: 'PowerShell 7', path: 'C:\\Program Files\\PowerShell\\pwsh.exe' }],
    });

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Windows shell')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Default Windows terminal shell' })).toBeVisible();
  });

  test('hides Windows shell controls on macOS and presents unsupported notifications', async ({ page }) => {
    await bootSettings(page, { platform: 'darwin', notificationsSupported: false });

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByText('Windows shell')).toHaveCount(0);
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    await expect(page.getByText('Unsupported', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable', exact: true })).toHaveCount(0);
  });

  test('renders a dark theme without changing the settings layout', async ({ page }) => {
    await bootSettings(page, { initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed' } });
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('combobox', { name: 'Theme' }).click();
    // Options carry their picker description in the accessible name; match the label prefix (not the OLED variant).
    await page.getByRole('option', { name: /^Night Owl(?! \(OLED\))/ }).click();
    await expect(page.locator('html')).toHaveClass(/night-owl/);
    await expect(page.getByRole('dialog', { name: 'Pane Settings' })).toBeVisible();
    await page.screenshot({ path: 'test-results/settings-dark.png' });
  });

  test('traps focus in the modal and restores it to the opener', async ({ page }) => {
    const opener = await bootSettings(page);
    const dialog = page.getByRole('dialog', { name: 'Pane Settings' });

    for (let index = 0; index < 30; index += 1) {
      await page.keyboard.press('Tab');
      const focusInside = await page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLElement && active.closest('[aria-modal="true"]') !== null;
      });
      expect(focusInside).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
});
