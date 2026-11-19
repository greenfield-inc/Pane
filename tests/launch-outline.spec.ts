import { expect as baseExpect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

// The launch outline (frontend/index.html): the window's first frame, with the launch chat's
// message box where the chat's own box mounts. Text, caret and an Enter typed before the app
// loads move into the chat (D-62).

// The renderer loads its whole app from a cold Vite server here, slower on CI than on a laptop.
const expect = baseExpect.configure({ timeout: 15_000 });
const now = new Date(0).toISOString();
const project = { id: 81, name: 'Launch fixture', path: '/tmp/launch-fixture', active: true, created_at: now, updated_at: now };
const pane = (id: string, name: string, displayOrder: number) => ({
  id, name, worktreePath: `/tmp/launch-fixture/${id}`, prompt: '', status: 'stopped', createdAt: now, lastActivity: now,
  output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', projectId: project.id, displayOrder,
  isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
});
const terminal = (id: string, sessionId: string, position: number, isActive = false) => ({
  id, sessionId, type: 'terminal', title: 'Terminal',
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position },
});
const panels = [
  terminal('dock-a', 'chat-a', 0),
  {
    id: 'chat', sessionId: 'chat-a', type: 'chat', title: 'Claude',
    state: { isActive: true, hasBeenViewed: true, customState: { agent: 'claude', launch: { kind: 'new' }, cwd: '/tmp/launch-fixture/chat-a', status: 'idle' } },
    metadata: { createdAt: now, lastActiveAt: now, position: 1 },
  },
  terminal('dock-b', 'other-b', 0, true),
];
const fixture: ElectronApiMockOptions = {
  platform: 'darwin',
  initialProjects: [project],
  initialSessions: [pane('chat-a', 'chat-pane', 0), pane('other-b', 'other-pane', 1)],
  initialPanels: panels,
  activeProjectId: project.id,
  launchChat: { paneId: 'chat-a', panelId: 'chat', dockTerminal: true },
};

const chatBox = (page: Page) => page.getByRole('textbox', { name: 'Message Claude' });
const launchBox = (page: Page) => page.locator('textarea[data-launch-composer]');

/** Holds the app's code (everything after index.html) until the returned release is called. */
async function holdApp(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/src\/main\.tsx$/, async route => {
    await released;
    await route.continue();
  });
  return release;
}

/**
 * Records, every frame, the launch box's last styled rect (it is gone once the chat mounts), and
 * any frame after it in which no message box sits at that rect.
 */
async function recordLaunchBox(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // SAFETY: test-only records read back by the spec.
    const record = window as typeof window & { __launchBox?: number[]; __gaps?: number[][] };
    record.__gaps = [];
    const rectOf = (element: Element) => { const { x, y, width, height } = element.getBoundingClientRect(); return [x, y, width, height]; };
    const tick = () => {
      const box = document.querySelector('textarea[data-launch-composer]');
      const chat = document.querySelector('textarea[data-chat-composer]');
      if (box && getComputedStyle(box).fontSize === '15px') record.__launchBox = rectOf(box);
      else if (record.__launchBox && !box) {
        const shown = chat ? rectOf(chat) : [];
        if (shown.join() !== record.__launchBox.join()) record.__gaps!.push(shown);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const rectOf = (page: Page) => chatBox(page).evaluate(element => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return [x, y, width, height];
});
// SAFETY: written by recordLaunchBox.
const recordedLaunchBox = (page: Page) => page.evaluate(() => (window as typeof window & { __launchBox?: number[] }).__launchBox);

const layouts: Array<{ name: string; storage: Record<string, string> }> = [
  { name: 'the default layout', storage: {} },
  { name: 'a 400 px sidebar and no inspector', storage: { 'pane-sidebar-width': '400', 'pane-detail-panel-visible': 'false' } },
  { name: 'a collapsed sidebar and a 300 px inspector', storage: { 'pane-sidebar-collapsed': 'true', 'pane-detail-panel-width:v2': JSON.stringify({ version: 2, preferredPx: 300 }) } },
];

for (const layout of layouts) {
  test(`the first frame's message box sits where the chat's box mounts, with ${layout.name}`, async ({ page }) => {
    await page.addInitScript((storage: Record<string, string>) => {
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    }, layout.storage);
    await recordLaunchBox(page);
    await installElectronApiMock(page, fixture);
    await page.goto('/');
    await expect(chatBox(page)).toBeVisible();
    const launched = await recordedLaunchBox(page);
    expect(launched).toBeDefined();
    expect(await rectOf(page)).toEqual(launched);
    // No frame between the outline and the chat showed the box missing or elsewhere.
    // SAFETY: written by recordLaunchBox.
    expect(await page.evaluate(() => (window as typeof window & { __gaps?: number[][] }).__gaps)).toEqual([]);
  });
}

test('a Custom theme paints its cached colours in the first frame, then the app\'s own sheet takes over', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pane.custom-theme.v1', JSON.stringify({ base: 'folio', theme: { base: 'folio', colors: { '--color-surface-secondary': '#402030', '--color-bad': 'url(https://example.com/x)' } } }));
  });
  const release = await holdApp(page);
  await installElectronApiMock(page, { ...fixture, initialConfig: { appearanceMode: 'fixed', theme: 'custom' } });
  await page.goto('/', { waitUntil: 'commit' });
  // Only the plain colour; the value that could load something is left out.
  expect(await page.locator('#pane-launch-custom-theme').evaluate(style => style.textContent)).toBe('html:root.pane-custom-theme { --color-surface-secondary: #402030; }');
  release();
  await expect(chatBox(page)).toBeVisible();
  // The app's own checked sheet (utils/customTheme.ts) replaces these colours.
  await expect(page.locator('#pane-launch-custom-theme')).toHaveCount(0);
});

test('text and caret typed before the app loads move into the chat, which takes focus', async ({ page }) => {
  const release = await holdApp(page);
  await installElectronApiMock(page, fixture);
  await page.goto('/', { waitUntil: 'commit' });
  await expect(launchBox(page)).toBeFocused();
  await page.keyboard.type('hello');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  release();
  await expect(chatBox(page)).toHaveValue('hello');
  await expect(chatBox(page)).toBeFocused();
  expect(await chatBox(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([3, 3]);
  await expect(page.locator('#pane-launch-outline')).toHaveCount(0);
});

test('Enter pressed before the app loads sends the message once the chat is ready, exactly once', async ({ page }) => {
  const release = await holdApp(page);
  await installElectronApiMock(page, fixture);
  await page.goto('/', { waitUntil: 'commit' });
  await expect(launchBox(page)).toBeFocused();
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  await expect(launchBox(page)).toHaveValue('hi');
  release();
  // SAFETY: installElectronApiMock defines this test-only bridge.
  const sends = () => page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getChatSends: () => Array<{ panelId: string; request: { text: string } }> } }).__paneTestElectronMock.getChatSends());
  await expect.poll(sends).toEqual([expect.objectContaining({ panelId: 'chat', request: expect.objectContaining({ text: 'hi' }) })]);
  await expect(chatBox(page)).toHaveValue('');
  await page.waitForTimeout(1000);
  expect(await sends()).toHaveLength(1);
});

test('an IME composition open when the chat mounts finishes in the first box, then its text moves once', async ({ page }) => {
  const release = await holdApp(page);
  await installElectronApiMock(page, fixture);
  await page.goto('/', { waitUntil: 'commit' });
  await expect(launchBox(page)).toBeFocused();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  release();
  await expect(chatBox(page)).toBeAttached();
  // Still composing: the first box keeps the composition.
  await expect(launchBox(page)).toHaveValue('にほ');
  await cdp.send('Input.insertText', { text: '日本' });
  await expect(chatBox(page)).toHaveValue('日本');
  await expect(chatBox(page)).toBeFocused();
  await expect(page.locator('#pane-launch-outline')).toHaveCount(0);
});

test('an Enter on an empty box, or followed by more typing, sends nothing', async ({ page }) => {
  const release = await holdApp(page);
  await installElectronApiMock(page, fixture);
  await page.goto('/', { waitUntil: 'commit' });
  await expect(launchBox(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('hel');
  await page.keyboard.press('Enter');
  await page.keyboard.type('lo');
  release();
  await expect(chatBox(page)).toHaveValue('hello');
  await page.waitForTimeout(1500);
  // SAFETY: installElectronApiMock defines this test-only bridge.
  expect(await page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getChatSends: () => unknown[] } }).__paneTestElectronMock.getChatSends())).toEqual([]);
  await expect(chatBox(page)).toHaveValue('hello');
});

test('the launch box refuses a paste over 1 MiB, as the chat\'s box does', async ({ page }) => {
  await holdApp(page);
  await installElectronApiMock(page, fixture);
  await page.goto('/', { waitUntil: 'commit' });
  await expect(launchBox(page)).toBeFocused();
  const refused = (length: number) => launchBox(page).evaluate((box, size) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'x'.repeat(size));
    const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true });
    box.dispatchEvent(event);
    return event.defaultPrevented;
  }, length);
  expect(await refused(1024 * 1024 + 1)).toBe(true);
  expect(await refused(10)).toBe(false);
});

test('the outline gives way within 10 s when the app cannot read its Panes', async ({ page }) => {
  test.setTimeout(45_000);
  await installElectronApiMock(page, fixture);
  await page.addInitScript(() => {
    window.electronAPI.sessions.getAll = () => {
      document.documentElement.dataset.askedForPanes = 'true';
      return Promise.reject(new Error('host offline'));
    };
  });
  await page.goto('/');
  await expect(launchBox(page)).toBeVisible();
  // The 10 s run from the app's start, which a cold dev server can hold back for seconds after the page loads.
  // The app asks for its Panes after it starts its clock, so the clock runs from no later than that.
  await expect(page.locator('html')).toHaveAttribute('data-asked-for-panes', 'true', { timeout: 30_000 });
  await expect(page.locator('#pane-launch-outline')).toHaveCount(0, { timeout: 12_000 });
});

test('a reload draws no message box: the person is already in the app', async ({ page }) => {
  await installElectronApiMock(page, fixture);
  await page.goto('/');
  await expect(chatBox(page)).toBeVisible();
  // Hold the app's code on the reload, so the outline stays to be read.
  await page.route(/\/src\/main\.tsx$/, () => undefined);
  await page.reload({ waitUntil: 'commit' });
  await expect(page.locator('#pane-launch-outline')).toHaveCount(1);
  await expect(launchBox(page)).toHaveCount(0);
});

test('a launch onto Home draws no message box, and the outline gives way to the app', async ({ page }) => {
  const release = await holdApp(page);
  await installElectronApiMock(page, { ...fixture, launchChat: undefined });
  await page.goto('/', { waitUntil: 'commit' });
  await expect(page.locator('#pane-launch-outline')).toHaveCount(1);
  await expect(launchBox(page)).toHaveCount(0);
  release();
  await expect(page.getByRole('button', { name: 'Expand project Launch fixture', exact: true })).toBeVisible();
  await expect(page.locator('#pane-launch-outline')).toHaveCount(0);
});

test('a person who goes elsewhere first finds their text waiting in the launch chat', async ({ page }) => {
  const release = await holdApp(page);
  // The chat's code arrives late, so the click lands before the launch chat opens.
  await page.route(/ChatTabRoute\.tsx/, async route => {
    await page.waitForTimeout(1500);
    await route.continue();
  });
  await installElectronApiMock(page, fixture);
  await page.goto('/', { waitUntil: 'commit' });
  await expect(launchBox(page)).toBeFocused();
  await page.keyboard.type('abc');
  release();
  await page.getByRole('button', { name: 'Expand project Launch fixture', exact: true }).click();
  await expect(page.locator('#pane-launch-outline')).toHaveCount(0);
  await page.getByRole('button', { name: 'chat-pane', exact: true }).click();
  await expect(chatBox(page)).toHaveValue('abc');
  // SAFETY: installElectronApiMock defines this test-only bridge.
  expect(await page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getChatSends: () => unknown[] } }).__paneTestElectronMock.getChatSends())).toEqual([]);
});
