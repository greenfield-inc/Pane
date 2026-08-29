import { expect, test, type Locator, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

type LinksMock = {
  getOpenedExternalUrls: () => string[];
  getPanelCreates: () => JsonObject[];
  getPanelUpdates: () => Array<{ panelId: string; updates: JsonObject }>;
  getPanelActivations: () => Array<{ sessionId: string; panelId: string }>;
};

const project = {
  id: 630,
  name: 'Terminal links fixture',
  path: '/tmp/terminal-links-fixture',
  active: true,
  environment: 'linux',
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const baseSession = {
  prompt: 'Verify terminal link routing',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};
const worktreeSession = { ...baseSession, id: 'links-worktree', name: 'Links worktree pane', worktreePath: `${project.path}/wt`, displayOrder: 0 };
const mainSession = { ...baseSession, id: 'links-main', name: 'Links main repo', worktreePath: project.path, isMainRepo: true, displayOrder: 1 };

const PLAIN_URL = 'https://plain.example.com/path';
const OSC_URL = 'https://osc.example.com/doc';
const GITHUB_REMOTE = 'https://github.com/dcouple/pane';
// Line 1: auto-detected URL · line 2: OSC-8 hyperlink · line 3: issue reference.
const SCROLLBACK = `${PLAIN_URL}\r\n\x1b]8;;${OSC_URL}\x1b\\OSCLINK\x1b]8;;\x1b\\\r\nfix #123 now\r\n`;

// A pinned (permanent) bottom terminal plus one tab terminal, as the popover spec seeds.
const terminalPanels = (sessionId: string, prefix: string) => ['Bottom Terminal', 'Tab Terminal'].map((title, index) => ({
  id: `${prefix}-${index}`,
  sessionId,
  type: 'terminal',
  title,
  state: { isActive: index === 1, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: new Date(index).toISOString(), lastActiveAt: new Date(index).toISOString(), position: index, permanent: index === 0 },
}));
const browserPanel = (sessionId: string) => ({
  id: 'existing-browser',
  sessionId,
  type: 'browser',
  title: 'Browser',
  state: { isActive: false, hasBeenViewed: true, customState: { currentUrl: 'https://before.example.com/' } },
  metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position: 1 },
});

type MockWindow = typeof window & { __paneTestElectronMock: LinksMock };

async function counts(page: Page) {
  return page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const mock = (window as MockWindow).__paneTestElectronMock;
    return {
      external: mock.getOpenedExternalUrls().length,
      creates: mock.getPanelCreates().length,
      updates: mock.getPanelUpdates().length,
      activations: mock.getPanelActivations().length,
    };
  });
}

async function openedUrls(page: Page): Promise<string[]> {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (window as MockWindow).__paneTestElectronMock.getOpenedExternalUrls());
}

async function panelCreates(page: Page): Promise<JsonObject[]> {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (window as MockWindow).__paneTestElectronMock.getPanelCreates());
}

async function panelUpdates(page: Page): Promise<Array<{ panelId: string; updates: JsonObject }>> {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (window as MockWindow).__paneTestElectronMock.getPanelUpdates());
}

/**
 * Hovers the terminal until the link tooltip names the expected link. WebGL
 * rendering leaves no DOM rows to measure, so the scan probes a column a few
 * cells into the text, row by row, and confirms linkification via the tooltip.
 */
async function hoverLink(page: Page, terminal: Locator, expectedLinkText: string) {
  const box = await terminal.locator('.xterm-screen').boundingBox();
  if (!box) throw new Error('Terminal screen has no bounding box');
  const x = box.x + 40;
  for (let offset = 4; offset < 120; offset += 3) {
    const y = box.y + offset;
    await page.mouse.move(x - 1, y);
    await page.mouse.move(x, y);
    const tooltip = page.getByRole('tooltip');
    try {
      await expect(tooltip).toContainText(expectedLinkText, { timeout: 250 });
      return { x, y };
    } catch {
      // keep scanning
    }
  }
  throw new Error(`No link tooltip for ${expectedLinkText}`);
}

async function activate(page: Page, at: { x: number; y: number }, modifiers: string[]) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

async function boot(page: Page, options: {
  platform: 'darwin' | 'linux';
  sessionName: string;
  extraPanels?: JsonObject[];
}) {
  await page.addInitScript((navigatorPlatform) => {
    Object.defineProperty(window.navigator, 'platform', { configurable: true, get: () => navigatorPlatform });
  }, options.platform === 'darwin' ? 'MacIntel' : 'Linux x86_64');
  await installElectronApiMock(page, {
    platform: options.platform,
    githubRemoteUrl: GITHUB_REMOTE,
    initialProjects: [project],
    initialSessions: [worktreeSession, mainSession],
    initialPanels: [...terminalPanels(worktreeSession.id, 'wt'), ...terminalPanels(mainSession.id, 'main'), ...(options.extraPanels ?? [])],
    initialTerminalStates: {
      'wt-0': { scrollbackBuffer: SCROLLBACK }, 'wt-1': { scrollbackBuffer: SCROLLBACK },
      'main-0': { scrollbackBuffer: SCROLLBACK }, 'main-1': { scrollbackBuffer: SCROLLBACK },
    },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Terminal links fixture$/ }).click();
  await page.getByRole('button', { name: options.sessionName, exact: true }).click();
  const terminal = page.getByRole('tabpanel').locator('.xterm').first();
  await expect(terminal.locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  return terminal;
}

const primary = (platform: 'darwin' | 'linux') => (platform === 'darwin' ? 'Meta' : 'Control');

for (const platform of ['darwin', 'linux'] as const) {
  test(`worktree: primary opens externally once and primary+shift opens the Pane Browser once (${platform})`, async ({ page }) => {
    const terminal = await boot(page, { platform, sessionName: worktreeSession.name });
    const mod = primary(platform);
    const hint = platform === 'darwin' ? '⌘+Click: external · ⇧⌘+Click: Pane Browser' : 'Ctrl+Click: external · Ctrl+Shift+Click: Pane Browser';

    // Auto-detected URL: plain click is inert, primary opens externally.
    let at = await hoverLink(page, terminal, PLAIN_URL);
    await expect(page.getByRole('tooltip')).toContainText(hint);
    await activate(page, at, []);
    await page.waitForTimeout(200);
    expect(await counts(page)).toMatchObject({ external: 0, creates: 0 });
    await activate(page, at, [mod]);
    await expect.poll(async () => (await counts(page)).external).toBe(1);
    expect(await openedUrls(page)).toEqual([PLAIN_URL]);
    expect(await counts(page)).toMatchObject({ creates: 0, updates: 0 });

    // Primary+Shift creates one Browser panel, activates it once, opens nothing externally.
    at = await hoverLink(page, terminal, PLAIN_URL);
    await activate(page, at, [mod, 'Shift']);
    await expect.poll(async () => (await counts(page)).creates).toBe(1);
    const created = (await panelCreates(page))[0];
    expect(created).toMatchObject({ sessionId: worktreeSession.id, type: 'browser', title: 'plain.example.com', state: { customState: { currentUrl: PLAIN_URL } } });
    await expect(page.getByRole('tab', { name: /plain\.example\.com|Browser/ })).toBeVisible();
    await page.waitForTimeout(200);
    // Two activations: the router's own, plus SessionView's layout sync when the
    // panel:created broadcast inserts the new tab (SessionView applyLayout) — the
    // same as any panel creation. No second navigation or external open occurs.
    expect(await counts(page)).toMatchObject({ external: 1, creates: 1, updates: 0, activations: 2 });
  });
}

test('worktree: OSC-8 plain click opens externally and git references route through the same policy', async ({ page }) => {
  const terminal = await boot(page, { platform: 'linux', sessionName: worktreeSession.name });

  let at = await hoverLink(page, terminal, OSC_URL);
  await expect(page.getByRole('tooltip')).toContainText('Click: external · Ctrl+Shift+Click: Pane Browser');
  await activate(page, at, []);
  await expect.poll(async () => (await counts(page)).external).toBe(1);
  expect(await openedUrls(page)).toEqual([OSC_URL]);

  at = await hoverLink(page, terminal, `${GITHUB_REMOTE}/issues/123`);
  await activate(page, at, []);
  await page.waitForTimeout(200);
  expect((await counts(page)).external).toBe(1);
  await activate(page, at, ['Control']);
  await expect.poll(async () => (await counts(page)).external).toBe(2);
  expect((await openedUrls(page)).at(-1)).toBe(`${GITHUB_REMOTE}/issues/123`);
  expect(await counts(page)).toMatchObject({ creates: 0, updates: 0 });
});

test('worktree: primary+shift reuses the existing Browser panel with one update and no external open', async ({ page }) => {
  const terminal = await boot(page, { platform: 'linux', sessionName: worktreeSession.name, extraPanels: [browserPanel(worktreeSession.id)] });
  const at = await hoverLink(page, terminal, PLAIN_URL);
  await activate(page, at, ['Control', 'Shift']);
  await expect.poll(async () => (await counts(page)).updates).toBe(1);
  const update = (await panelUpdates(page))[0];
  expect(update.panelId).toBe('existing-browser');
  expect(update.updates).toMatchObject({ state: { customState: { currentUrl: PLAIN_URL } } });
  await page.waitForTimeout(200);
  expect(await counts(page)).toMatchObject({ external: 0, creates: 0, updates: 1, activations: 1 });
});

// Pane Chat's terminal never leaves its CLI loading overlay under the mock bridge, so its
// external-only routing is pinned by canHostSessionBrowser's unit test and the manual QA drive.
for (const context of ['main-repo'] as const) {
  test(`${context}: primary+shift falls back to the external browser exactly once and creates no panel`, async ({ page }) => {
    const terminal = await boot(page, { platform: 'linux', sessionName: mainSession.name });
    const at = await hoverLink(page, terminal, PLAIN_URL);
    await expect(page.getByRole('tooltip')).toContainText('Ctrl+Click: external (Pane Browser unavailable here)');
    await activate(page, at, ['Control', 'Shift']);
    await expect.poll(async () => (await counts(page)).external).toBe(1);
    await page.waitForTimeout(200);
    expect(await counts(page)).toMatchObject({ external: 1, creates: 0, updates: 0, activations: 0 });
  });
}
