import { expect, test, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import {
  loseWebglContext,
  readSnapshot,
  scrollUp,
  selectFirstLine,
  writeLines,
  xtermEvaluate,
} from './terminalXterm';

test.describe.configure({ mode: 'serial' });
const now = new Date(0).toISOString();
const project = {
  id: 610,
  name: 'Terminal blur fixture',
  path: '/tmp/terminal-blur-fixture',
  active: true,
  created_at: now,
  updated_at: now,
};
const session = {
  id: 'terminal-blur-session',
  name: 'Blur recovery',
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
const otherSession = {
  ...session,
  id: 'terminal-blur-other-session',
  name: 'Other session',
  displayOrder: 1,
};

const terminalPanel = (id: string, sessionId: string, title: string, position: number, isActive: boolean, permanent = false) => ({
  id,
  sessionId,
  type: 'terminal',
  title,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: true } },
  metadata: { createdAt: now, lastActiveAt: now, position, permanent },
});

const primaryPanel = terminalPanel('blur-primary', session.id, 'Primary', 1, true);
const secondaryPanel = terminalPanel('blur-secondary', session.id, 'Secondary', 2, false);
const dockPanel = {
  ...terminalPanel('blur-dock', session.id, 'Terminal', 0, false, true),
  state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } },
};
const otherPanel = terminalPanel('blur-other', otherSession.id, 'Other shell', 1, true);
const otherDockPanel = {
  ...terminalPanel('blur-other-dock', otherSession.id, 'Terminal', 0, false, true),
  state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } },
};

interface InvokeCall {
  channel: string;
  args: unknown[];
}

interface ConsolePayload {
  args?: unknown[];
}

interface TerminalMock {
  emitPanelTerminalOutput(sessionId: string, panelId: string, output: string): void;
  emitWindowFocusChanged(focused: boolean): void;
  getConsoleLogCalls(): ConsolePayload[];
  getInvokeCalls(channel: string): InvokeCall[];
}

interface MaskAppearance {
  at: number;
  ownerId: string | null;
}

interface BootFixtureResult {
  panel: Locator;
  webglLoaded: boolean;
}

declare global {
  interface Window {
    __maskAppearances?: MaskAppearance[];
    __resumeTerminalRequest?: () => void;
    __terminalEchoPaints?: Array<{ start: number; end: number }>;
    __terminalEchoRows?: number;
  }
}

async function installMaskRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__maskAppearances = [];
    const recordMask = (mask: Element) => {
      window.__maskAppearances?.push({
        at: performance.now(),
        ownerId: mask.closest('[role="tabpanel"]')?.id ?? null,
      });
    };
    const recordMasks = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches('[data-testid="terminal-activation-mask"]')) {
        recordMask(node);
      }
      for (const mask of node.querySelectorAll('[data-testid="terminal-activation-mask"]')) {
        recordMask(mask);
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) recordMasks(node);
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

function initialScrollback(prefix: string, count = 80): string {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join('\r\n') + '\r\n';
}

async function bootFixture(
  page: Page,
  powerMode: 'performance' | 'batterySaver' = 'performance',
  alternateScreen = false,
  systemAppearance = false,
  platform: 'darwin' | 'win32' = 'darwin',
  extraPanels: Array<ReturnType<typeof terminalPanel>> = [],
): Promise<BootFixtureResult> {
  if (systemAppearance) await page.emulateMedia({ colorScheme: 'light' });
  await page.clock.install();
  await installMaskRecorder(page);
  const initialConfig = systemAppearance
    ? {
        terminalPowerMode: powerMode,
        appearanceMode: 'system',
        theme: 'light-rounded',
        systemLightTheme: 'folio',
        systemDarkTheme: 'forge',
      }
    : { terminalPowerMode: powerMode };
  await installElectronApiMock(page, {
    platform,
    initialConfig,
    initialProjects: [project],
    initialSessions: [session, otherSession],
    initialPanels: [dockPanel, primaryPanel, secondaryPanel, ...extraPanels, otherDockPanel, otherPanel],
    initialTerminalStates: {
      ...Object.fromEntries(extraPanels.map((extra) => [extra.id, { scrollbackBuffer: initialScrollback(extra.id, 10) }])),
      [primaryPanel.id]: { scrollbackBuffer: initialScrollback('primary'), isAlternateScreen: alternateScreen },
      [secondaryPanel.id]: { scrollbackBuffer: initialScrollback('secondary', 10) },
      [otherPanel.id]: { scrollbackBuffer: initialScrollback('other', 10) },
    },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Terminal blur fixture$/ }).click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: primaryPanel.title });
  await expect(panel.locator('.xterm-screen')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('terminal-activation-mask')).toHaveCount(0);
  await expect.poll(() => lifecycleLogs(page).then((logs) => (
    logs.filter((line) => line.includes(`Activation depth for panel ${primaryPanel.id}: full`)).length
  ))).toBe(1);
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`WebGL renderer loaded for panel ${primaryPanel.id}`)
    || line.includes(`WebGL renderer failed for panel ${primaryPanel.id}`)
  )))).toBe(true);
  const logs = await lifecycleLogs(page);
  return {
    panel,
    webglLoaded: logs.some((line) => line.includes(`WebGL renderer loaded for panel ${primaryPanel.id}`)),
  };
}

async function mockEvaluate<T>(page: Page, fn: (mock: TerminalMock) => T): Promise<T> {
  return page.evaluate((fnSource) => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const mock = (window as typeof window & { __paneTestElectronMock: TerminalMock }).__paneTestElectronMock;
    // SAFETY: fnSource comes from the typed callback passed to mockEvaluate.
    const evaluate = new Function(`return (${fnSource})`)() as (value: TerminalMock) => T;
    return evaluate(mock);
  }, fn.toString());
}

async function lifecycleLogs(page: Page): Promise<string[]> {
  const payloads = await mockEvaluate(page, (mock) => mock.getConsoleLogCalls());
  return payloads.flatMap((payload) => (
    Array.isArray(payload.args) && payload.args[0] !== undefined ? [String(payload.args[0])] : []
  ));
}

async function resetMaskAppearances(page: Page): Promise<void> {
  await page.evaluate(() => { window.__maskAppearances = []; });
}

async function maskAppearances(page: Page, panel?: Locator): Promise<MaskAppearance[]> {
  const ownerId = panel ? await panel.getAttribute('id') : null;
  if (panel && !ownerId) throw new Error('Terminal panel locator has no id');
  return page.evaluate((expectedOwnerId) => {
    const appearances = window.__maskAppearances ?? [];
    return expectedOwnerId ? appearances.filter(({ ownerId }) => ownerId === expectedOwnerId) : appearances;
  }, ownerId);
}

// Several cells each way at the default font (a 16 px cell is about 10 x 20 px),
// so the terminal's cols and rows both change.
const VIEWPORT_SHRINK_PX = { width: 120, height: 80 };

async function shrinkViewport(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Playwright viewport is unset; this test resizes it.');
  await page.setViewportSize({
    width: viewport.width - VIEWPORT_SHRINK_PX.width,
    height: viewport.height - VIEWPORT_SHRINK_PX.height,
  });
}

async function pauseClock(page: Page): Promise<void> {
  const pageNow = await page.evaluate(() => Date.now());
  // Leave time for the protocol round trip on busy hosts; a 10 ms lead can
  // already be in the past when the pause command reaches the browser.
  await page.clock.pauseAt(pageNow + 1000);
}

async function emitFocus(page: Page, focused: boolean): Promise<void> {
  await page.evaluate((nextFocused) => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const mock = (window as typeof window & { __paneTestElectronMock: TerminalMock }).__paneTestElectronMock;
    mock.emitWindowFocusChanged(nextFocused);
  }, focused);
}

async function advanceActivation(page: Page): Promise<void> {
  for (let elapsed = 0; elapsed < 900; elapsed += 50) {
    await page.clock.runFor(50);
  }
}

// Wait for every mounted TerminalPanel to commit the focus change before the
// fake clock moves. In battery saver the same passive-effect flush that arms the
// blur-detach timer also reports the gated visibility to main, so waiting for
// that recorded invoke proves the timer is armed; a fixed wall-clock sleep raced
// React's effect flush under load and armed the timer mid-`runFor`.
async function waitForWindowFocusState(page: Page, focused: boolean): Promise<void> {
  const stale = focused ? 'false' : 'true';
  await expect(page.locator(`[data-window-focused="${stale}"]`)).toHaveCount(0);
  await expect(page.locator('[data-window-focused]').first()).toHaveAttribute('data-window-focused', String(focused));
}

async function waitForVisibilityGate(page: Page, panelId: string, visible: boolean): Promise<void> {
  await expect.poll(() => mockEvaluate(page, (mock) => mock.getInvokeCalls('terminal:setVisibility')).then((calls) => (
    calls.filter((call) => call.args[0] === panelId).at(-1)?.args[1]
  ))).toBe(visible);
}

async function blurFor(page: Page, durationMs: number, options: { gatedPanelId?: string } = {}): Promise<void> {
  await emitFocus(page, false);
  await waitForWindowFocusState(page, false);
  if (options.gatedPanelId) await waitForVisibilityGate(page, options.gatedPanelId, false);
  await page.clock.runFor(durationMs);
}

async function refocus(page: Page): Promise<void> {
  await resetMaskAppearances(page);
  await emitFocus(page, true);
  await waitForWindowFocusState(page, true);
  await advanceActivation(page);
}

for (const durationMs of [9_999, 10_000, 10_001]) {
  test(`performance blur boundary preserves the mounted terminal at ${durationMs} ms`, async ({ page }) => {
    const { panel, webglLoaded } = await bootFixture(page);
    expect((await maskAppearances(page)).length).toBeGreaterThan(0);
    expect(await xtermEvaluate(panel, (terminal) => terminal.buffer.active.length)).toBeGreaterThan(0);

    await writeLines(panel, 200);
    await expect.poll(() => readSnapshot(panel).then((snapshot) => snapshot.lines.length)).toBeGreaterThan(200);
    await selectFirstLine(panel);
    await scrollUp(panel, 20);
    const before = await readSnapshot(panel);
    await pauseClock(page);

    await blurFor(page, durationMs);
    await refocus(page);

    const after = await readSnapshot(panel);
    const logs = await lifecycleLogs(page);
    const sawMask = (await maskAppearances(page, panel)).length > 0;
    const sawTimeoutDetach = logs.some((line) => line.includes(`panel ${primaryPanel.id} reason=app-blur-timeout`));
    const depths = logs.filter((line) => line.includes(`Activation depth for panel ${primaryPanel.id}:`));
    const lastDepth = depths.at(-1)?.split(': ').at(-1);

    expect(sawMask).toBe(false);
    if (webglLoaded) expect(sawTimeoutDetach).toBe(false);
    expect(lastDepth).toBe('light');
    expect(after).toEqual(before);
  });
}

test('battery saver retains delayed detach and full recovery', async ({ page }) => {
  const { panel, webglLoaded } = await bootFixture(page, 'batterySaver');
  const fullDepthLine = `Activation depth for panel ${primaryPanel.id}: full`;
  const fullDepthCount = (lines: string[]) => lines.filter((line) => line.includes(fullDepthLine)).length;
  const fullDepthBeforeBlur = fullDepthCount(await lifecycleLogs(page));
  await pauseClock(page);
  await blurFor(page, 10_001, { gatedPanelId: primaryPanel.id });
  if (webglLoaded) {
    // Battery saver's contract is "detaches after the delay", not "at this exact
    // tick": under load React can install the detach timer a few fake ms after
    // the clock starts moving, so keep stepping (well short of a second cycle)
    // until the detach is observed.
    const detachLine = `panel ${primaryPanel.id} reason=app-blur-timeout`;
    for (let extra = 0; extra < 2_000; extra += 100) {
      if ((await lifecycleLogs(page)).some((line) => line.includes(detachLine))) break;
      await page.clock.runFor(100);
    }
    expect((await lifecycleLogs(page)).some((line) => line.includes(detachLine))).toBe(true);
  }
  await refocus(page);
  const logs = await lifecycleLogs(page);
  expect(await maskAppearances(page, panel)).not.toEqual([]);
  // Boot already logged one full activation; the refocus must add another so
  // a battery-saver refocus that wrongly selected `hot` cannot pass on boot alone.
  expect(fullDepthCount(logs)).toBe(fullDepthBeforeBlur + 1);
});

test('panel hide and show at an unchanged size shows the hot activation without a mask', async ({ page }) => {
  const { panel, webglLoaded } = await bootFixture(page);
  const webglLoads = async () => (await lifecycleLogs(page)).filter((line) => (
    line.includes(`WebGL renderer loaded for panel ${primaryPanel.id}`)
  )).length;
  const loadsBefore = await webglLoads();
  const before = await readSnapshot(panel);
  await page.getByRole('tab', { name: secondaryPanel.title, exact: true }).click();
  const secondary = page.getByRole('tabpanel', { name: secondaryPanel.title });
  await expect(secondary).toBeVisible();
  await expect(secondary.getByTestId('terminal-activation-mask')).toHaveCount(0);
  await resetMaskAppearances(page);
  await page.getByRole('tab', { name: primaryPanel.title, exact: true }).click();
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`Activation depth for panel ${primaryPanel.id}: hot`)
  )))).toBe(true);
  expect(await maskAppearances(page, panel)).toEqual([]);
  expect(await readSnapshot(panel)).toEqual(before);
  // The hidden panel kept its WebGL renderer, so showing it attached no new one.
  if (webglLoaded) expect(await webglLoads()).toBe(loadsBefore);
});

test('a font change while hidden masks the next hot activation', async ({ page }) => {
  const { panel } = await bootFixture(page);
  const fontSize = await xtermEvaluate(panel, (terminal) => terminal.options.fontSize ?? 0);
  const largerFontSize = fontSize * 2;
  // Role queries skip hidden tab panels, so keep this one's element id to reach it hidden.
  const hiddenPanel = page.locator(`[id="${await panel.getAttribute('id')}"]`);
  await page.getByRole('tab', { name: secondaryPanel.title, exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: secondaryPanel.title })).toBeVisible();
  await page.evaluate((size) => window.electronAPI.config.update({ terminalFontSize: size }), largerFontSize);
  await expect.poll(() => xtermEvaluate(hiddenPanel, (terminal) => terminal.options.fontSize)).toBe(largerFontSize);
  await resetMaskAppearances(page);
  await page.getByRole('tab', { name: primaryPanel.title, exact: true }).click();
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`Activation depth for panel ${primaryPanel.id}: hot`)
  )))).toBe(true);
  expect(await maskAppearances(page, panel)).not.toEqual([]);
});

test('hidden tabs release their kept WebGL renderers oldest first before the browser limit', async ({ page }) => {
  // Chromium keeps at most 16 live WebGL contexts per renderer process.
  const chromiumMaxWebglContexts = 16;
  const extraPanels = Array.from({ length: chromiumMaxWebglContexts - 2 }, (_, index) => (
    terminalPanel(`blur-extra-${index}`, session.id, `Extra ${index}`, 3 + index, false)
  ));
  const { panel, webglLoaded } = await bootFixture(page, 'performance', false, false, 'darwin', extraPanels);
  test.skip(!webglLoaded, 'WebGL renderer not attached; there is no renderer to keep in this browser');
  // Each tab's first activation is a full refresh; its delayed backstop logs
  // after the tab became eligible to keep its renderer while hidden.
  for (const next of [secondaryPanel, ...extraPanels]) {
    await page.getByRole('tab', { name: next.title, exact: true }).click();
    await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
      line.includes(`Delayed activation refresh for panel ${next.id}`)
    )))).toBe(true);
  }
  const released = (panelId: string) => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`WebGL renderer detached for panel ${panelId} reason=hidden-renderer-cap`)
  )));
  expect(await released(primaryPanel.id)).toBe(true);
  expect(await released(extraPanels[extraPanels.length - 2].id)).toBe(false);
  // The released tab attaches a new context when shown, so it stays masked.
  await resetMaskAppearances(page);
  await page.getByRole('tab', { name: primaryPanel.title, exact: true }).click();
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`Activation depth for panel ${primaryPanel.id}: hot`)
  )))).toBe(true);
  expect(await maskAppearances(page, panel)).not.toEqual([]);
});

test('panel hide and show after a resize retains the masked hot activation', async ({ page }) => {
  const { panel } = await bootFixture(page);
  await page.getByRole('tab', { name: secondaryPanel.title, exact: true }).click();
  const secondary = page.getByRole('tabpanel', { name: secondaryPanel.title });
  await expect(secondary).toBeVisible();
  await expect(secondary.getByTestId('terminal-activation-mask')).toHaveCount(0);
  await shrinkViewport(page);
  await resetMaskAppearances(page);
  await page.getByRole('tab', { name: primaryPanel.title, exact: true }).click();
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`Activation depth for panel ${primaryPanel.id}: hot`)
  )))).toBe(true);
  expect(await maskAppearances(page, panel)).not.toEqual([]);
});

test('a resize while visible does not mask the next hot activation', async ({ page }) => {
  const { panel } = await bootFixture(page);
  const resizesOf = () => mockEvaluate(page, (mock) => mock.getInvokeCalls('terminal:resize').length);
  const resizesBefore = await resizesOf();
  await shrinkViewport(page);
  await expect.poll(resizesOf).toBeGreaterThan(resizesBefore);
  await page.getByRole('tab', { name: secondaryPanel.title, exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: secondaryPanel.title })).toBeVisible();
  await resetMaskAppearances(page);
  await page.getByRole('tab', { name: primaryPanel.title, exact: true }).click();
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`Activation depth for panel ${primaryPanel.id}: hot`)
  )))).toBe(true);
  expect(await maskAppearances(page, panel)).toEqual([]);
});

test('session remount retains full recovery', async ({ page }) => {
  const { panel } = await bootFixture(page);
  await page.getByRole('button', { name: otherSession.name, exact: true }).click();
  const other = page.getByRole('tabpanel', { name: otherPanel.title });
  await expect(other.locator('.xterm-screen')).toBeVisible();
  await expect(other.getByTestId('terminal-activation-mask')).toHaveCount(0);
  await resetMaskAppearances(page);
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await expect.poll(() => lifecycleLogs(page).then((logs) => (
    logs.filter((line) => line.includes(`Activation depth for panel ${primaryPanel.id}: full`)).length
  ))).toBeGreaterThan(1);
  expect(await maskAppearances(page, panel)).not.toEqual([]);
});

for (const alternateScreen of [false, true]) {
  test(`Windows hot activation (${alternateScreen ? 'alternate' : 'normal'}) waits for backstop resize then only lingers once`, async ({ page }) => {
    const { panel } = await bootFixture(page, 'performance', false, false, 'win32');
    if (alternateScreen) {
      await xtermEvaluate(panel, terminal => new Promise<void>(resolve => terminal.write('\x1b[?1049h\x1b[2Jhot alternate buffer', resolve)));
    }
    const before = await readSnapshot(panel);
    await page.getByRole('tab', { name: secondaryPanel.title, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: secondaryPanel.title }).getByTestId('terminal-activation-mask')).toHaveCount(0);
    // Resize while hidden: an unchanged-size hot activation is unmasked, and
    // this test covers the masked one.
    await shrinkViewport(page);
    await pauseClock(page);
    const stateCallsBefore = await mockEvaluate(page, mock => mock.getInvokeCalls('terminal:getState').length);
    await page.evaluate(panelId => {
      const invoke = window.electronAPI.invoke;
      let backstopStarted = false;
      window.electronAPI.invoke = async (channel, ...args) => {
        if (channel === 'console:log' && JSON.stringify(args).includes(`Delayed activation refresh for panel ${panelId}`)) {
          backstopStarted = true;
        }
        if (channel === 'terminal:resize' && args[0] === panelId && backstopStarted) {
          backstopStarted = false;
          await new Promise<void>(resolve => { window.__resumeTerminalRequest = resolve; });
        }
        return invoke(channel, ...args);
      };
    }, primaryPanel.id);
    await page.getByRole('tab', { name: primaryPanel.title, exact: true }).click();
    await advanceActivation(page);
    expect(await page.evaluate(() => window.__resumeTerminalRequest !== undefined)).toBe(true);
    await expect(panel.getByTestId('terminal-activation-mask')).toHaveCount(1);
    await page.evaluate(() => { window.__resumeTerminalRequest?.(); });
    // Two paint frames, then the existing 150 ms overlay linger. The previous
    // additional 200 ms hot-path timer would still have the mask up here.
    for (let elapsed = 0; elapsed < 250; elapsed += 25) await page.clock.runFor(25);
    await expect(panel.getByTestId('terminal-activation-mask')).toHaveCount(0);
    expect(await mockEvaluate(page, mock => mock.getInvokeCalls('terminal:getState').length)).toBe(stateCallsBefore);
    // The resize changes the row count (and the alternate screen's blank rows),
    // so compare the written content and bottom-follow.
    const written = (lines: string[]) => lines.filter(line => line.trim() !== '');
    const after = await readSnapshot(panel);
    expect(written(after.lines)).toEqual(written(before.lines));
    expect(after.viewportY).toBe(after.baseY);
  });
}

for (const pendingRequest of ['refocus-resize', 'forced-resize'] as const) {
  test(`switching sessions during ${pendingRequest} does not produce a disposed-terminal error`, async ({ page }) => {
    const { panel } = await bootFixture(page, 'performance', pendingRequest === 'forced-resize');
    const failures: string[] = [];
    page.on('dialog', async (dialog) => {
      failures.push(dialog.message());
      await dialog.dismiss();
    });
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (message) => {
      if (message.text().includes('Failed to refresh terminal')) failures.push(message.text());
    });

    // Hold one resize reply until switching sessions has disposed its caller's xterm.
    await page.evaluate(({ panelId, pendingRequest }) => {
      const invoke = window.electronAPI.invoke;
      let held = false;
      window.electronAPI.invoke = async (channel, ...args) => {
        const matchesRequest = channel === 'terminal:resize' && (pendingRequest !== 'forced-resize'
          || (args[3] instanceof Object && 'force' in args[3] && args[3].force === true));
        if (!held && args[0] === panelId && matchesRequest) {
          held = true;
          await new Promise<void>((resolve) => { window.__resumeTerminalRequest = resolve; });
        }
        return invoke(channel, ...args);
      };
    }, { panelId: primaryPanel.id, pendingRequest });

    if (pendingRequest === 'refocus-resize') {
      await emitFocus(page, false);
      await waitForWindowFocusState(page, false);
      await emitFocus(page, true);
    } else {
      await panel.hover();
      await panel.getByTitle('Refresh terminal').click();
    }
    await expect.poll(() => page.evaluate(() => window.__resumeTerminalRequest !== undefined)).toBe(true);

    await page.getByRole('button', { name: otherSession.name, exact: true }).click();
    await expect(panel).toHaveCount(0);
    const other = page.getByRole('tabpanel', { name: otherPanel.title });
    await expect(other.locator('.xterm-screen')).toBeVisible();
    await expect(other.getByTestId('terminal-activation-mask')).toHaveCount(0);
    const before = await readSnapshot(other);

    await page.evaluate(() => { window.__resumeTerminalRequest?.(); });
    await advanceActivation(page);

    expect(failures).toEqual([]);
    expect(await readSnapshot(other)).toEqual(before);
  });
}

test('WebGL context loss keeps content readable without an activation mask', async ({ page }) => {
  const { panel, webglLoaded } = await bootFixture(page);
  test.skip(!webglLoaded, 'WebGL renderer not attached; context-loss path is not reachable in this browser');
  const before = await readSnapshot(panel);
  await resetMaskAppearances(page);
  const reachable = await loseWebglContext(panel);
  test.skip(!reachable, 'context-loss: not reachable headless; deferred to QA drive');
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => line.includes('WebGL context lost')))).toBe(true);
  expect(await readSnapshot(panel)).toEqual(before);
  expect(await maskAppearances(page, panel)).toEqual([]);
});

test('alternate-screen battery-saver recovery retains forced PTY resize', async ({ page }) => {
  await bootFixture(page, 'batterySaver', true);
  await pauseClock(page);
  await blurFor(page, 10_001);
  const callsBeforeRefocus = await mockEvaluate(page, (mock) => mock.getInvokeCalls('terminal:resize'));
  await refocus(page);
  const calls = await mockEvaluate(page, (mock) => mock.getInvokeCalls('terminal:resize'));
  const newCalls = calls.slice(callsBeforeRefocus.length);
  expect(newCalls.length).toBeGreaterThan(0);
  expect(newCalls.some((call) => (
    call.args.length === 4
    && call.args[3] instanceof Object
    && 'force' in call.args[3]
    && call.args[3].force === true
  ))).toBe(true);
});

test('alternate-screen performance refocus does not force PTY resize', async ({ page }) => {
  await bootFixture(page, 'performance', true);
  await pauseClock(page);
  await blurFor(page, 10_001);
  const callsBeforeRefocus = await mockEvaluate(page, (mock) => mock.getInvokeCalls('terminal:resize'));
  await refocus(page);
  const callsAfter = await mockEvaluate(page, (mock) => mock.getInvokeCalls('terminal:resize'));
  const newCalls = callsAfter.slice(callsBeforeRefocus.length);
  expect(newCalls.length).toBeGreaterThan(0);
  expect(newCalls.every((call) => (
    call.args[3] instanceof Object
    && 'force' in call.args[3]
    && call.args[3].force === false
  ))).toBe(true);
});

test('manual Refresh retains the opaque activation mask', async ({ page }) => {
  const { panel } = await bootFixture(page);
  await resetMaskAppearances(page);
  await panel.hover();
  await panel.getByTitle('Refresh terminal').click();
  await expect.poll(() => maskAppearances(page, panel).then((entries) => entries.length)).toBeGreaterThan(0);
});

test('performance mode accepts output while blurred without a repeated tail', async ({ page }) => {
  const { panel } = await bootFixture(page);
  await writeLines(panel, 7);
  await expect.poll(() => readSnapshot(panel).then((snapshot) => snapshot.lines.at(-1))).toContain('blur-line-');
  await pauseClock(page);
  await emitFocus(page, false);
  await page.waitForTimeout(50);
  await writeLines(panel, 5);
  await page.clock.runFor(10_001);
  await refocus(page);
  const snapshot = await readSnapshot(panel);
  const addedLines = snapshot.lines.filter((line) => line.startsWith('blur-line-'));
  expect(addedLines).toHaveLength(12);
  expect(new Set(addedLines).size).toBe(12);
  expect(await maskAppearances(page, panel)).toEqual([]);
});

test('System appearance changes while blurred preserve the scrolled viewport without a mask', async ({ page }) => {
  const { panel } = await bootFixture(page, 'performance', false, true);
  await writeLines(panel, 200);
  await expect.poll(() => readSnapshot(panel).then((snapshot) => snapshot.lines.length)).toBeGreaterThan(200);
  await scrollUp(panel, 20);
  const before = await readSnapshot(panel);
  expect(before.viewportY).toBeLessThan(before.baseY);

  await pauseClock(page);
  await resetMaskAppearances(page);
  await emitFocus(page, false);
  await page.waitForTimeout(50);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/forge/);
  await expect.poll(() => readSnapshot(panel).then((snapshot) => snapshot.viewportY)).toBe(before.viewportY);

  await emitFocus(page, true);
  await advanceActivation(page);
  const after = await readSnapshot(panel);
  expect(after.viewportY).toBe(before.viewportY);
  expect(await maskAppearances(page, panel)).toEqual([]);
});

// A composer echo usually changes one row. Calling scrollToBottom at an already
// settled bottom promotes xterm's dirty range to a full-viewport redraw.
test('Windows terminal echo repaints only changed rows at the bottom', async ({ page }) => {
  const { panel } = await bootFixture(page, 'performance', false, false, 'win32');
  await page.clock.runFor(1000);
  await xtermEvaluate(panel, (terminal) => {
    // SAFETY: the helper returns a real xterm; these are public xterm APIs.
    const observed = terminal as typeof terminal & {
      rows: number;
      onRender(callback: (range: { start: number; end: number }) => void): { dispose(): void };
    };
    window.__terminalEchoPaints = [];
    window.__terminalEchoRows = observed.rows;
    observed.onRender(range => window.__terminalEchoPaints?.push(range));
  });
  await mockEvaluate(page, mock => mock.emitPanelTerminalOutput(
    'terminal-blur-session', 'blur-primary', '\rtyping into the agent composer',
  ));
  await page.clock.runFor(250);
  const paints = await page.evaluate(() => ({
    ranges: window.__terminalEchoPaints ?? [],
    rows: window.__terminalEchoRows ?? 0,
  }));
  expect(paints.ranges.length).toBeGreaterThan(0);
  expect(paints.ranges.every(range => range.end - range.start + 1 < paints.rows)).toBe(true);
  const after = await readSnapshot(panel);
  expect(after.lines.at(-1)).toContain('typing into the agent composer');
  expect(after.viewportY).toBe(after.baseY);
});

test('terminal output preserves history viewing and follows new lines at the bottom', async ({ page }) => {
  const { panel } = await bootFixture(page, 'performance', false, false, 'win32');
  await page.clock.runFor(1000);
  await scrollUp(panel, 20);
  await page.clock.runFor(100);
  const before = await readSnapshot(panel);
  expect(before.viewportY).toBeLessThan(before.baseY);
  await mockEvaluate(page, mock => mock.emitPanelTerminalOutput(
    'terminal-blur-session', 'blur-primary', '\rstill drafting',
  ));
  await page.clock.runFor(250);
  expect((await readSnapshot(panel)).viewportY).toBe(before.viewportY);
  await xtermEvaluate(panel, terminal => terminal.scrollLines(10000));
  await page.clock.runFor(100);
  await mockEvaluate(page, mock => mock.emitPanelTerminalOutput(
    'terminal-blur-session', 'blur-primary', '\r\nnext output\r\n',
  ));
  await page.clock.runFor(250);
  const after = await readSnapshot(panel);
  expect(after.viewportY).toBe(after.baseY);
  expect(after.baseY).toBeGreaterThan(before.baseY);
  expect(after.lines.at(-1)).toBe('next output');
});

test('opt-in timing records independent numeric stages without terminal content', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pane:terminalTiming', '1'));
  const { panel } = await bootFixture(page, 'performance', false, false, 'win32');
  await panel.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('private-input');
  await mockEvaluate(page, mock => mock.emitPanelTerminalOutput(
    'terminal-blur-session', 'blur-primary', '\rprivate-output',
  ));
  await page.clock.runFor(500);
  const timings = await page.evaluate(() => window.paneTerminalTiming?.snapshot());
  expect(timings?.inputRoundTrip.count).toBeGreaterThan(0);
  expect(timings?.outputParse.count).toBeGreaterThan(0);
  expect(timings?.outputRender.count).toBeGreaterThan(0);
  expect(JSON.stringify(timings)).not.toContain('private');
  expect(JSON.stringify(timings)).not.toContain('blur-primary');
  for (const metric of Object.values(timings ?? {})) {
    expect(metric.recentMs.length).toBeLessThanOrEqual(128);
    expect(metric.recentMs.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
  }
});
