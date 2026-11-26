import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, gotoApp } from './electronApiMock';

/** The stub pad the init script installs. */
interface PadStub {
  set(index: number, value: number): void;
  setAxis(index: number, value: number): void;
  connect(): void;
  rumbles(): number;
  /** How many times the page read navigator.getGamepads(). */
  reads(): number;
}

declare global {
  interface Window {
    __pad: PadStub;
  }
}

// A game controller drives the desktop app (docs/CONTROLLERS.md). The pad is a
// stub behind navigator.getGamepads(), numbered the way Chromium numbers a
// standard-mapped pad: 0 bottom, 1 right, 2 left, 3 top, 4/5 shoulders,
// 6/7 triggers, 8/9 select/start, 10/11 stick clicks, 12-15 the D-pad.

const BUTTON = { south: 0, east: 1, west: 2, north: 3, l1: 4, r1: 5, l2: 6, r2: 7, select: 8, start: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15 } as const;
type Button = keyof typeof BUTTON;

const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const SWITCH_PRO = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';

const now = new Date(0).toISOString();
const project = { id: 91, name: 'Pad fixture', path: '/tmp/pad-fixture', active: true, created_at: now, updated_at: now };
const pane = (id: string, name: string, displayOrder: number) => ({
  id, name, worktreePath: `/tmp/pad-fixture/${id}`, prompt: '', status: 'stopped', createdAt: now, lastActivity: now,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder,
  isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
});
const terminal = (id: string, sessionId: string, title: string, position: number, isActive = false) => ({
  id, sessionId, type: 'terminal', title,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position },
});
const sessions = [pane('pad-a', 'pad-pane', 0)];
// The first terminal is the Pane's bottom dock; the tabs come after it.
const panels = [
  terminal('dock-a', 'pad-a', 'Terminal', 0),
  terminal('agent', 'pad-a', 'Agent', 1, true),
  terminal('shell', 'pad-a', 'Shell', 2),
];

async function installPad(page: Page, id: string, mapping: string): Promise<void> {
  await page.addInitScript(({ padId, padMapping }: { padId: string; padMapping: string }) => {
    const pad = { buttons: Array.from({ length: 17 }, () => 0), axes: [0, 0, 0, 0], timestamp: 0, rumbles: 0, reads: 0 };
    const snapshot = () => ({
      id: padId, index: 0, connected: true, mapping: padMapping, timestamp: pad.timestamp,
      buttons: pad.buttons.map(value => ({ pressed: value > 0, touched: value > 0, value })),
      axes: [...pad.axes],
      vibrationActuator: { playEffect: async () => { pad.rumbles += 1; return 'complete'; } },
    });
    // Like Chromium, no pad shows until one is connected and pressed.
    let connected = false;
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => { pad.reads += 1; return connected ? [snapshot()] : [null]; } });
    window.__pad = {
      set(index: number, value: number) { pad.buttons[index] = value; pad.timestamp += 1; },
      setAxis(index: number, value: number) { pad.axes[index] = value; pad.timestamp += 1; },
      connect() {
        connected = true;
        const event = new Event('gamepadconnected');
        Object.defineProperty(event, 'gamepad', { value: snapshot() });
        window.dispatchEvent(event);
      },
      rumbles: () => pad.rumbles,
      reads: () => pad.reads,
    };
  }, { padId: id, padMapping: mapping });
}

/** Presses and releases a button, a frame apart so the adapter sees both. */
async function press(page: Page, button: Button): Promise<void> {
  await page.evaluate(index => window.__pad.set(index, 1), BUTTON[button]);
  await page.waitForTimeout(50);
  await page.evaluate(index => window.__pad.set(index, 0), BUTTON[button]);
  await page.waitForTimeout(50);
}

async function openFixture(page: Page, padId = XBOX, preferences: Record<string, string> = { controller_cheat_sheet_seen: 'true' }, connect = true, mapping = 'standard'): Promise<void> {
  await installPad(page, padId, mapping);
  await installElectronApiMock(page, { initialProjects: [project], initialSessions: sessions, initialPanels: panels, activeProjectId: project.id, initialPreferences: preferences });
  await gotoApp(page);
  await page.getByRole('button', { name: 'Expand project Pad fixture', exact: true }).click();
  await page.getByRole('button', { name: 'pad-pane', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Loading terminal' })).toHaveCount(0);
  if (connect) await page.evaluate(() => window.__pad.connect());
}

const terminalInputs = (page: Page, panelId: string) => page.evaluate(id => {
  // SAFETY: installElectronApiMock puts the mock's hooks on window, and getInvokeCalls returns each call's args.
  const mock = (window as typeof window & { __paneTestElectronMock: { getInvokeCalls(channel: string): Array<{ args: unknown[] }> } }).__paneTestElectronMock;
  return mock.getInvokeCalls('terminal:input').filter(call => call.args[0] === id).map(call => call.args[1]);
}, panelId);

test('the first press shows the cheat sheet once, in the pad\'s letters, and B closes it', async ({ page }, testInfo) => {
  // The mock answers an unknown preference 'true', so a fresh install is spelled out.
  await openFixture(page, SWITCH_PRO, { controller_cheat_sheet_seen: 'false' });
  await press(page, 'south');
  const sheet = page.getByTestId('controller-cheat-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('controller-cheat-sheet-device')).toHaveText('Pro Controller');
  // A Switch pad: R2 reads ZR, and the sheet lists A for "Open or pick".
  await expect(sheet).toContainText('ZR');
  await page.screenshot({ path: testInfo.outputPath('cheat-sheet-switch-pro.png') });
  // On a Nintendo pad B is the bottom button.
  await press(page, 'south');
  await expect(sheet).toBeHidden();
  await press(page, 'south');
  await expect(sheet).toBeHidden();
});

test('in a terminal the D-pad sends arrows, A sends Enter, X opens the key pad, Y sends Enter alone', async ({ page }, testInfo) => {
  await openFixture(page);
  await page.locator('.xterm').first().click();
  await press(page, 'up');
  await press(page, 'south');
  await expect.poll(() => terminalInputs(page, 'agent')).toEqual(['\x1b[A', '\r']);

  await press(page, 'west');
  const keyPad = page.getByTestId('controller-key-pad');
  await expect(keyPad).toBeVisible();
  await expect(page.getByRole('button', { name: 'Esc' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('key-pad.png') });
  // Right to ^C, then A.
  await press(page, 'right');
  await expect(page.getByRole('button', { name: '^C' })).toBeFocused();
  await press(page, 'south');
  await expect.poll(() => terminalInputs(page, 'agent')).toEqual(['\x1b[A', '\r', '\x03']);
  await press(page, 'east');
  await expect(keyPad).toBeHidden();

  await page.locator('.xterm').first().click();
  await press(page, 'north');
  await expect.poll(() => terminalInputs(page, 'agent')).toEqual(['\x1b[A', '\r', '\x03', '\r']);
  await expect.poll(() => page.evaluate(() => window.__pad.rumbles())).toBe(1);
});

test('L1 and R1 step through tabs on release, and holding both changes no tab', async ({ page }) => {
  await openFixture(page);
  const selected = page.locator('[data-pane-part="tab"][aria-selected="true"]');
  await expect(selected).toHaveAttribute('data-panel-id', 'agent');
  await press(page, 'r1');
  await expect(selected).toHaveAttribute('data-panel-id', 'shell');
  await press(page, 'l1');
  await expect(selected).toHaveAttribute('data-panel-id', 'agent');
  // The chord: L1 down, R1 down, both up.
  await page.evaluate(() => window.__pad.set(4, 1));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__pad.set(5, 1));
  await page.waitForTimeout(50);
  await page.evaluate(() => { const pad = window.__pad; pad.set(4, 0); pad.set(5, 0); });
  await page.waitForTimeout(100);
  await expect(selected).toHaveAttribute('data-panel-id', 'agent');
});

test('B goes back to the sidebar, the D-pad walks it with a visible ring, and the mouse hides the ring', async ({ page }, testInfo) => {
  await openFixture(page);
  await page.locator('.xterm').first().click();
  await press(page, 'east');
  await expect(page.getByRole('button', { name: 'pad-pane', exact: true })).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-controller-mode', 'true');
  await press(page, 'up');
  await expect(page.getByRole('button', { name: 'pad-pane', exact: true })).not.toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('sidebar-ring.png') });
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 320);
  await expect(page.locator('html')).not.toHaveAttribute('data-controller-mode', 'true');
  // The left stick alone brings the ring back.
  await page.evaluate(() => window.__pad.setAxis(1, 1));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__pad.setAxis(1, 0));
  await expect(page.locator('html')).toHaveAttribute('data-controller-mode', 'true');
});

test('holding R2 with no voice key says where to add one', async ({ page }, testInfo) => {
  await openFixture(page);
  await page.locator('.xterm').first().click();
  await page.evaluate(() => window.__pad.set(7, 1));
  const bar = page.getByTestId('controller-listening-bar');
  await expect(bar).toContainText('Settings › Integrations');
  await page.screenshot({ path: testInfo.outputPath('dictation-needs-key.png') });
  await page.evaluate(() => window.__pad.set(7, 0));
});

test('with no pad connected, Pane never polls for one', async ({ page }) => {
  await openFixture(page, XBOX, { controller_cheat_sheet_seen: 'true' }, false);
  const before = await page.evaluate(() => window.__pad.reads());
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__pad.reads())).toBe(before);
});

test('a pad with no known layout says so once, and the note stays closed after it is dismissed', async ({ page }, testInfo) => {
  await openFixture(page, 'Mystery Pad (Vendor: 1234 Product: 5678)', { controller_cheat_sheet_seen: 'false' }, true, '');
  await press(page, 'south');
  const note = page.getByTestId('controller-cheat-sheet-note');
  await expect(note).toContainText("can't read this controller's layout");
  await page.screenshot({ path: testInfo.outputPath('unrecognised-pad.png') });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(note).toBeHidden();
  await press(page, 'south');
  await press(page, 'east');
  await expect(note).toBeHidden();
});
