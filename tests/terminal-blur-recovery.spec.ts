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
    platform: 'darwin',
    initialConfig,
    initialProjects: [project],
    initialSessions: [session, otherSession],
    initialPanels: [dockPanel, primaryPanel, secondaryPanel, otherDockPanel, otherPanel],
    initialTerminalStates: {
      [primaryPanel.id]: { scrollbackBuffer: initialScrollback('primary'), isAlternateScreen: alternateScreen },
      [secondaryPanel.id]: { scrollbackBuffer: initialScrollback('secondary', 10) },
      [otherPanel.id]: { scrollbackBuffer: initialScrollback('other', 10) },
    },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Terminal blur fixture$/ }).click();
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

async function pauseClock(page: Page): Promise<void> {
  const pageNow = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(pageNow + 10);
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

test('panel hide and show retains the masked hot activation', async ({ page }) => {
  const { panel } = await bootFixture(page);
  await page.getByRole('tab', { name: secondaryPanel.title, exact: true }).click();
  const secondary = page.getByRole('tabpanel', { name: secondaryPanel.title });
  await expect(secondary).toBeVisible();
  await expect(secondary.getByTestId('terminal-activation-mask')).toHaveCount(0);
  await resetMaskAppearances(page);
  await page.getByRole('tab', { name: primaryPanel.title, exact: true }).click();
  await expect.poll(() => lifecycleLogs(page).then((logs) => logs.some((line) => (
    line.includes(`Activation depth for panel ${primaryPanel.id}: hot`)
  )))).toBe(true);
  expect(await maskAppearances(page, panel)).not.toEqual([]);
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
