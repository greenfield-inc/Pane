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

async function openFixture(page: Page, { approvals = false }: { approvals?: boolean } = {}): Promise<void> {
  const options: Parameters<typeof installElectronApiMock>[1] = {
    initialProjects: [project], initialSessions: sessions, initialPanels: panels, initialLayout: layout,
    activeProjectId: project.id,
  };
  if (approvals) options.notifySnapshot = notifyFixture();
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
  await page.getByTestId('approvals-queue').getByRole('heading', { name: 'Approvals' }).click();
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
