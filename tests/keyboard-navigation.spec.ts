import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import { notifyFixture } from './fixtures/notifySnapshot';

declare global {
  interface Window {
    __clears?: string[];
  }
}

// Keyboard navigation across the window (P3, journeys 3 to 5): ⌘0 walks the
// sidebar, ⌘⌥+arrows cross region edges, F6 cycles, and focus shows quietly.

const now = new Date(0).toISOString();
const project = { id: 77, name: 'Nav fixture', path: '/tmp/nav-fixture', active: true, created_at: now, updated_at: now };
const pane = (id: string, name: string, displayOrder: number) => ({
  id, name, worktreePath: `/tmp/nav-fixture/${id}`, prompt: '', status: 'stopped', createdAt: now, lastActivity: now,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder,
  isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
});
const sessions = [pane('nav-a', 'auth-refactor', 0), pane('nav-b', 'billing-migration', 1)];
const terminal = (id: string, title: string, position: number, isActive = false) => ({
  id, sessionId: 'nav-a', type: 'terminal', title,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position },
});
const panels = [terminal('dock', 'Terminal', 0), terminal('alpha', 'Alpha', 1, true), terminal('beta', 'Beta', 2)];
const layout = {
  version: 1,
  focusedGroupId: 'g-left',
  root: {
    type: 'split', id: 's-root', direction: 'row', sizes: [1, 1],
    children: [
      { type: 'group', id: 'g-left', panelIds: ['alpha'], activePanelId: 'alpha' },
      { type: 'group', id: 'g-right', panelIds: ['beta'], activePanelId: 'beta' },
    ],
  },
};

type MockOptions = NonNullable<Parameters<typeof installElectronApiMock>[1]>;

async function openFixture(page: Page, { approvals = false, initialConfig }: { approvals?: boolean; initialConfig?: MockOptions['initialConfig'] } = {}): Promise<void> {
  const options: MockOptions = {
    initialProjects: [project], initialSessions: sessions, initialPanels: panels, initialLayout: layout,
    activeProjectId: project.id,
  };
  if (approvals) options.notifySnapshot = notifyFixture();
  if (initialConfig) options.initialConfig = initialConfig;
  await installElectronApiMock(page, options);
  await page.addInitScript(() => localStorage.setItem('pane-detail-panel-visible', 'true'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand project Nav fixture', exact: true }).click();
  await page.getByRole('button', { name: 'auth-refactor', exact: true }).click();
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeVisible();
  // A terminal that finishes opening focuses itself; let both settle first.
  await expect(page.locator('[data-panel-group-id] .xterm-helper-textarea')).toHaveCount(2);
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
}

/** Which region and group hold keyboard focus. */
async function focusPlace(page: Page): Promise<{ region: string | null; group: string | null; label: string | null }> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return {
      region: active?.closest('[data-focus-region]')?.getAttribute('data-focus-region') ?? null,
      group: active?.closest('[data-panel-group-id]')?.getAttribute('data-panel-group-id') ?? null,
      label: active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? null,
    };
  });
}

test('⌘0 puts the cursor on the open Pane, and the arrows walk up into the top buttons and back', async ({ page }) => {
  await openFixture(page);
  await page.locator('[data-panel-group-id="g-left"] .xterm-helper-textarea, [data-panel-group-id="g-left"]').first().click();
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar', label: 'auth-refactor' });

  // The sidebar lists billing-migration above auth-refactor.
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'billing-migration' });
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'auth-refactor' });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'Collapse project Nav fixture' });

  // ← collapses the project, → expands it again, and the cursor stays.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button', { name: 'Expand project Nav fixture', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Collapse project Nav fixture', exact: true })).toBeFocused();

  // Up past the projects into the top buttons: Loops, Pane Chat, New, Search.
  const seen: string[] = [];
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('ArrowUp');
    seen.push((await focusPlace(page)).label ?? '');
  }
  expect(seen).toEqual(expect.arrayContaining(['Loops', 'Pane Chat', 'New', 'Search']));
  await page.keyboard.press('End');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar' });
});

test('j and k move down and up the sidebar like the arrows, but only while a row has focus', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar', label: 'auth-refactor' });

  // The sidebar lists billing-migration above auth-refactor, and the project row above both.
  await page.keyboard.press('k');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'billing-migration' });
  await page.keyboard.press('k');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'Collapse project Nav fixture' });
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'auth-refactor' });
  // The arrows still work, and shifted J and K are not moves.
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'billing-migration' });
  await page.keyboard.press('Shift+J');
  await expect.poll(() => focusPlace(page)).toMatchObject({ label: 'billing-migration' });

  // Outside the sidebar, j is just a letter: it reaches the terminal and focus stays there.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });
});

test('Space opens a Pane and keeps the cursor; Enter opens it and moves into its split; Esc goes back', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'billing-migration', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'billing-migration', exact: true })).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'auth-refactor', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });

  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar' });
  await page.keyboard.press('Escape');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });
});

test('⌘⌥→ jumps from the sidebar through both splits to the right panel and back; only the active split keeps its accent', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  const strips = page.locator('.panel-group-tab-bar .panel-tab-strip');
  // With focus in the sidebar, no split's tab carries the accent.
  await expect(strips.nth(0)).toHaveClass(/panel-tab-strip-dimmed/);
  await expect(strips.nth(1)).toHaveClass(/panel-tab-strip-dimmed/);

  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main', group: 'g-left' });
  await expect(strips.nth(0)).not.toHaveClass(/panel-tab-strip-dimmed/);
  await expect(strips.nth(1)).toHaveClass(/panel-tab-strip-dimmed/);

  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main', group: 'g-right' });
  await expect(strips.nth(0)).toHaveClass(/panel-tab-strip-dimmed/);
  await expect(strips.nth(1)).not.toHaveClass(/panel-tab-strip-dimmed/);

  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'right-panel' });

  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-right' });
  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-left' });
  await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar' });
});

test('F6 and ⇧F6 cycle the sidebar, the splits and the right panel', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  const order: Array<string | null> = [];
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press('F6');
    const place = await focusPlace(page);
    order.push(place.group ?? place.region);
  }
  expect(order).toEqual(['g-left', 'g-right', 'right-panel', 'sidebar']);
  await page.keyboard.press('Shift+F6');
  await expect.poll(async () => (await focusPlace(page)).region).toBe('right-panel');
});

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Two-step maximize: ⌘K, then ⌘M (D-250), with ⌘ held throughout. In a
 * terminal, letting go of ⌘ after ⌘K means "clear", as in VS Code.
 */
async function maximizeKey(page: Page): Promise<void> {
  await page.keyboard.down(MOD);
  await page.keyboard.press('k');
  await page.keyboard.press('m');
  await page.keyboard.up(MOD);
}

test('⌘K ⌘M maximizes the focused split with a pressed restore button, and restores', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-left' });

  await page.keyboard.down(MOD);
  await page.keyboard.press('k');
  await expect(page.getByTestId('key-sequence-hint')).toBeVisible();
  await page.keyboard.press('m');
  await page.keyboard.up(MOD);
  await expect(page.getByTestId('key-sequence-hint')).toHaveCount(0);
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeHidden();
  const restore = page.locator('[data-panel-group-id="g-left"]').getByTestId('restore-region');
  await expect(restore).toHaveAttribute('aria-pressed', 'true');
  await expect(restore).toHaveAttribute('aria-label', /Restore \(.+K.+M\)/);
  // The sidebar and right panel stay.
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.locator('.pane-detail-panel-vertical')).toBeVisible();

  await maximizeKey(page);
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeVisible();
  await expect(page.getByTestId('restore-region')).toHaveCount(0);

  // The button restores too.
  await maximizeKey(page);
  await page.getByTestId('restore-region').click();
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeVisible();
});

test('the right panel and the sidebar maximize over the main area and restore', async ({ page }) => {
  await openFixture(page);
  const splitWidth = await page.locator('[data-panel-group-id="g-left"]').evaluate(element => element.getBoundingClientRect().width);
  await page.keyboard.press('ControlOrMeta+0');
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'right-panel' });
  await maximizeKey(page);
  const panel = page.locator('.pane-detail-panel-inner').first();
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().left)).toBeLessThan(400);
  // The splits keep their size underneath, so no terminal refits.
  expect(await page.locator('[data-panel-group-id="g-left"]').evaluate(element => element.getBoundingClientRect().width)).toBe(splitWidth);
  await maximizeKey(page);
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().left)).toBeGreaterThan(900);

  await page.keyboard.press('ControlOrMeta+0');
  await maximizeKey(page);
  await expect.poll(() => page.getByTestId('sidebar').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(1000);
  await expect(page.getByTestId('sidebar').getByTestId('restore-region')).toBeVisible();
  await maximizeKey(page);
  await expect.poll(() => page.getByTestId('sidebar').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(500);
});

test('⌘⇧M minimizes the focused side region and moves focus to the main area; on a split it does nothing', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+0');
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'right-panel' });
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect.poll(() => page.locator('.pane-detail-panel-vertical').evaluate(element => element.getBoundingClientRect().width)).toBe(0);
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });

  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeVisible();
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });

  await page.keyboard.press('ControlOrMeta+0');
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(page.getByRole('button', { name: 'Expand sidebar' }).first()).toBeVisible();
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });
});

test('⌘K alone in a focused terminal still clears it; ⌘K ⌘M held does not', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const calls: string[] = [];
    window.__clears = calls;
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'terminal:clearScrollback') calls.push(String(args[0]));
      return invoke(channel, ...args);
    };
  });
  const clears = () => page.evaluate(() => window.__clears?.length ?? 0);
  await page.locator('[data-panel-group-id="g-left"] .xterm-helper-textarea').focus();
  await page.keyboard.press('ControlOrMeta+k');
  await expect.poll(clears).toBe(1);
  await expect(page.getByTestId('key-sequence-hint')).toHaveCount(0);

  await maximizeKey(page);
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeHidden();
  expect(await clears()).toBe(1);
});

interface NavigateMock {
  emitNotifyNavigate: (target: 'toggle-inbox') => void;
}

/** The Notify shortcut pressed while Pane is in front: main sends `toggle-inbox` (D-251). */
async function pressApprovalsKey(page: Page): Promise<void> {
  await page.evaluate(() => {
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    (window as typeof window & { __paneTestElectronMock: NavigateMock }).__paneTestElectronMock.emitNotifyNavigate('toggle-inbox');
  });
}

test('the Approvals key goes to Approvals, names where back goes, and returns to the same split and tab', async ({ page }) => {
  await openFixture(page, { approvals: true });
  await page.keyboard.press('ControlOrMeta+0');
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-right' });

  await pressApprovalsKey(page);
  await expect(page.getByTestId('approvals-queue')).toBeVisible();
  await expect(page.getByTestId('approvals-back-hint')).toContainText('back to');
  await expect(page.getByTestId('approvals-back-hint')).toContainText('Beta');

  await pressApprovalsKey(page);
  await expect(page.getByTestId('approvals-queue')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'auth-refactor', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-right' });
  await expect(page.locator('[data-panel-group-id="g-right"]').getByRole('tab', { name: 'Beta', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('Esc leaves Approvals for where you were, but not while an answer is being typed', async ({ page }) => {
  await openFixture(page, { approvals: true });
  await page.locator('[data-panel-group-id="g-left"] .xterm-helper-textarea').focus();
  await page.getByTestId('approvals-nav').click();
  await expect(page.getByTestId('approvals-queue')).toBeVisible();

  // Typing an answer: Esc belongs to the field and Approvals stays.
  await page.getByTestId('approvals-queue').getByRole('button', { name: 'Details' }).click();
  const field = page.getByTestId('notify-inbox').getByRole('textbox').first();
  await field.focus();
  await page.keyboard.type('Postgres');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('approvals-queue')).toBeVisible();
  // Esc with the cursor still on the sidebar's Approvals row leaves Approvals too.
  await page.getByTestId('approvals-nav').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('approvals-queue')).toHaveCount(0);
  await expect.poll(() => focusPlace(page)).toMatchObject({ group: 'g-left' });
});

test('the palette shows a command\'s key, and its Actions change it, reset it and show it in Keyboard Shortcuts', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+Shift+P');
  const input = page.getByRole('combobox').or(page.getByPlaceholder('Search')).first();
  await input.fill('>maximize');
  const row = page.getByRole('option', { name: /Maximize or Restore Focused Region/ }).first();
  await expect(row).toContainText(/K.*M/);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('option', { name: 'Change key…' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Show in Keyboard Shortcuts' })).toBeVisible();
  await page.getByRole('option', { name: 'Change key…' }).click();
  await expect(page.getByTestId('palette-key-recorder')).toBeVisible();

  // ⌘B is Toggle Sidebar: refused, and recording carries on.
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('palette-key-recorder')).toContainText('Toggle Sidebar');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByTestId('palette-key-status')).toContainText('Maximize');
  await input.fill('>maximize');
  await expect(page.getByRole('option', { name: /Maximize or Restore Focused Region/ }).first()).toContainText(/Enter|↩/);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('option', { name: 'Reset to default' }).click();
  await input.fill('>maximize');
  await expect(page.getByRole('option', { name: /Maximize or Restore Focused Region/ }).first()).toContainText(/K.*M/);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('option', { name: 'Show in Keyboard Shortcuts' }).click();
  await expect(page.getByRole('textbox', { name: 'Search shortcuts' })).toHaveValue(/Maximize/);
});

type ConfigUpdate = NonNullable<MockOptions['initialConfig']>;

interface ConfigMock {
  getConfigUpdates: () => ConfigUpdate[];
}

async function configUpdates(page: Page): Promise<ConfigUpdate[]> {
  return page.evaluate(() => {
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    return (window as typeof window & { __paneTestElectronMock: ConfigMock }).__paneTestElectronMock.getConfigUpdates();
  });
}

test('a key changed in Keyboard Shortcuts works at once and after a relaunch; a taken key blocks Apply', async ({ page, browser }) => {
  await openFixture(page);
  // ⌘K ⌘S with ⌘ held, since a terminal has focus (⌘K alone would clear it).
  await page.keyboard.down(MOD);
  await page.keyboard.press('k');
  await page.keyboard.press('s');
  await page.keyboard.up(MOD);
  const search = page.getByRole('textbox', { name: 'Search shortcuts' });
  await search.fill('sidebar');
  const row = page.locator('[data-shortcut-id="focus-sidebar"]');
  await row.getByRole('button', { name: /Record shortcut for Focus Sidebar/ }).click();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect(row).toContainText(/E/);

  // ⌘B is Toggle Sidebar's: the table names it and Apply stays blocked.
  const toggle = page.locator('[data-shortcut-id="toggle-sidebar"]');
  await row.getByRole('button', { name: /Record shortcut for Focus Sidebar/ }).click();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(row.getByRole('alert')).toContainText('Toggle Sidebar');
  await expect(page.getByRole('button', { name: 'Apply', exact: true }).first()).toBeDisabled();
  await row.getByRole('button', { name: /Record shortcut for Focus Sidebar/ }).click();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect(toggle.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply', exact: true }).first().click();
  await expect.poll(async () => (await configUpdates(page)).some(update => JSON.stringify(update).includes('"focus-sidebar":"mod+shift+e"'))).toBe(true);

  await page.getByTestId('settings-page').getByRole('button', { name: /Close|Back/ }).first().click();
  await expect(page.getByTestId('settings-page')).toHaveCount(0);
  await page.locator('[data-panel-group-id="g-left"]').click();
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });
  // ⌘0 no longer focuses the sidebar; ⌘⇧E does.
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'main' });
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar' });

  // A relaunch reads the saved override.
  const relaunched = await browser.newPage();
  await openFixture(relaunched, { initialConfig: { keyboardShortcutOverrides: { 'focus-sidebar': 'mod+shift+e' } } });
  await relaunched.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(() => focusPlace(relaunched)).toMatchObject({ region: 'sidebar' });
  await relaunched.close();
});

test('existing configs get one notice of the moved keys; it stays dismissed; a fresh install sees none', async ({ page }) => {
  await openFixture(page, { initialConfig: { keymapNotice: 'pending' } });
  const notice = page.getByTestId('keymap-notice');
  await expect(notice).toBeVisible();
  for (const moved of ['Previous / next tab', 'Toggle right panel', 'Maximize', 'Focus sidebar']) {
    await expect(notice).toContainText(moved);
  }
  await notice.getByRole('button', { name: 'Got it' }).click();
  await expect(notice).toHaveCount(0);
  expect(await configUpdates(page)).toContainEqual({ keymapNotice: 'seen' });

  const fresh = await page.context().newPage();
  await openFixture(fresh, { initialConfig: { keymapNotice: 'seen' } });
  await expect(fresh.getByTestId('keymap-notice')).toHaveCount(0);
  await fresh.close();
});

test('⌘A and ⌘⇧Z stay with a text field: Select All and Redo, not a Pane key', async ({ page }) => {
  await openFixture(page);
  await page.keyboard.press('ControlOrMeta+Shift+P');
  const input = page.getByPlaceholder('Search');
  await input.fill('hello world');
  await page.keyboard.press('ControlOrMeta+a');
  expect(await input.evaluate(element => {
    // SAFETY: the Search placeholder belongs to the palette's text input.
    const field = element as HTMLInputElement;
    return [field.selectionStart, field.selectionEnd];
  })).toEqual([0, 11]);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  // Redo ran in the field, and no Pane command took the key.
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('restore-region')).toHaveCount(0);
});

test('the tab keys move focus into the tab they show', async ({ page }) => {
  const withGamma = { ...layout, root: { ...layout.root, children: [
    { type: 'group', id: 'g-left', panelIds: ['alpha', 'gamma'], activePanelId: 'alpha' },
    layout.root.children[1],
  ] } };
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: sessions,
    initialPanels: [...panels, terminal('gamma', 'Gamma', 3)], initialLayout: withGamma, activeProjectId: project.id,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Expand project Nav fixture', exact: true }).click();
  await page.getByRole('button', { name: 'auth-refactor', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  await page.locator('[data-panel-group-id="g-left"] [role="tabpanel"]:not([aria-hidden="true"]) .xterm-helper-textarea').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+BracketRight' : 'Control+PageDown');
  await expect(page.locator('[data-panel-group-id="g-left"]').getByRole('tab', { name: 'Gamma', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => {
    const panel = document.activeElement?.closest('[role="tabpanel"]');
    return panel ? document.getElementById(panel.getAttribute('aria-labelledby') ?? '')?.getAttribute('aria-label') ?? null : null;
  })).toBe('Gamma');
});

test('maximize and restore refit a visible terminal behind its loading overlay', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const seen = { overlay: false };
    Object.assign(window, { __overlaySeen: seen });
    new MutationObserver(() => {
      if (document.querySelector('[data-panel-group-id="g-left"] [role="status"][aria-label="Loading terminal"]')) seen.overlay = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await page.locator('[data-panel-group-id="g-left"] .xterm-helper-textarea').focus();
  await maximizeKey(page);
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: the observer above stored this flag on window.
    return (window as typeof window & { __overlaySeen: { overlay: boolean } }).__overlaySeen.overlay;
  })).toBe(true);
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
});

test('a failed refit still lifts the terminal\'s overlay (F-1)', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => channel === 'terminal:resize'
      ? Promise.reject(new Error('resize refused'))
      : invoke(channel, ...args);
  });
  await page.locator('[data-panel-group-id="g-left"] .xterm-helper-textarea').focus();
  await maximizeKey(page);
  await expect(page.locator('[data-panel-group-id="g-right"]')).toBeHidden();
  await expect(page.locator('[data-panel-group-id="g-left"]').getByRole('status', { name: 'Loading terminal' })).toHaveCount(0, { timeout: 5000 });
});

test('an older refit never lifts the mask a newer refresh still holds (F-1)', async ({ page }) => {
  await openFixture(page);
  // Holds terminal:resize calls, and terminal:getState once asked, until the test lets them go.
  await page.evaluate(() => {
    const resizes: Array<() => void> = [];
    const snapshots: Array<() => void> = [];
    const held = { resizes, snapshots, holdSnapshots: false };
    Object.assign(window, { __held: held });
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'terminal:resize') {
        return new Promise(resolve => held.resizes.push(() => resolve(invoke(channel, ...args))));
      }
      if (channel === 'terminal:getState' && held.holdSnapshots) {
        return new Promise(resolve => held.snapshots.push(() => resolve(invoke(channel, ...args))));
      }
      return invoke(channel, ...args);
    };
  });
  const control = (action: 'hold-snapshots' | 'release-resizes' | 'release-all' | 'resizes' | 'snapshots') => page.evaluate((what) => {
    // SAFETY: the evaluate above installed window.__held with exactly this shape.
    const held = (window as typeof window & { __held: { resizes: Array<() => void>; snapshots: Array<() => void>; holdSnapshots: boolean } }).__held;
    if (what === 'hold-snapshots') held.holdSnapshots = true;
    if (what === 'release-resizes' || what === 'release-all') held.resizes.splice(0).forEach(release => release());
    if (what === 'release-all') {
      held.holdSnapshots = false;
      held.snapshots.splice(0).forEach(release => release());
    }
    return what === 'snapshots' ? held.snapshots.length : held.resizes.length;
  }, action);

  const left = page.locator('[data-panel-group-id="g-left"]');
  const mask = left.getByRole('status', { name: 'Loading terminal' });
  await left.locator('.xterm-helper-textarea').focus();
  await maximizeKey(page);
  await expect(mask).toHaveCount(1);
  // A manual refresh starts while the maximize refit still waits on its resize.
  await control('hold-snapshots');
  await left.getByTitle('Refresh terminal').dispatchEvent('click');
  await expect.poll(() => control('resizes')).toBeGreaterThan(1);
  // The refit finishes; the refresh still waits for its snapshot, so the mask stays.
  await control('release-resizes');
  await expect.poll(() => control('snapshots')).toBe(1);
  await control('release-resizes');
  await page.waitForTimeout(1500);
  await expect(mask).toHaveCount(1);
  await control('release-all');
  await expect(mask).toHaveCount(0, { timeout: 5000 });
});

test('in the swapped layout, the bottom inspector maximizes, restores and minimizes (F-4)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pane-layout-swapped', 'true'));
  await openFixture(page);
  const inspector = page.locator('.pane-detail-panel-horizontal');
  await expect(inspector).toBeVisible();
  await inspector.locator('button').first().focus();
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'right-panel' });
  await maximizeKey(page);
  await expect(inspector.getByTestId('restore-region')).toBeVisible();
  await inspector.getByTestId('restore-region').click();
  await expect(inspector.getByTestId('restore-region')).toHaveCount(0);
  await inspector.locator('button').first().focus();
  await page.keyboard.press('ControlOrMeta+Shift+M');
  await expect(inspector).toHaveAttribute('data-region-open', 'false');
});

test('Approvals returns to a sidebar row when that is where focus was (F-5)', async ({ page }) => {
  await openFixture(page, { approvals: true });
  await page.keyboard.press('ControlOrMeta+0');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar', label: 'billing-migration' });
  await pressApprovalsKey(page);
  await expect(page.getByTestId('approvals-queue')).toBeVisible();
  await pressApprovalsKey(page);
  await expect(page.getByTestId('approvals-queue')).toHaveCount(0);
  await expect.poll(() => focusPlace(page)).toMatchObject({ region: 'sidebar', label: 'billing-migration' });
});
