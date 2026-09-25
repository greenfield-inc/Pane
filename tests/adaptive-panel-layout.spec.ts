import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = {
  id: 941,
  name: 'Adaptive layout fixture',
  path: '/tmp/adaptive-layout-fixture',
  active: true,
  created_at: now,
  updated_at: now,
};

const worktreeSession = {
  id: 'adaptive-session',
  name: 'Adaptive pane',
  worktreePath: '/tmp/adaptive-layout-fixture/adaptive-session',
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

const mainRepoSession = {
  ...worktreeSession,
  id: 'adaptive-main-session',
  name: 'Adaptive layout fixture',
  worktreePath: project.path,
  isMainRepo: true,
  baseBranch: 'main',
};

function panel(sessionId: string, id: string, type: string, position: number, permanent = false) {
  return {
    id,
    sessionId,
    type,
    title: type === 'terminal' ? 'Terminal' : type === 'explorer' ? 'Explorer' : 'Logs',
    state: { isActive: type === 'logs', hasBeenViewed: true, customState: type === 'terminal' ? { isInitialized: false } : undefined },
    metadata: { createdAt: now, lastActiveAt: now, position, permanent },
  };
}

const panels = [
  panel(worktreeSession.id, 'adaptive-dock', 'terminal', 0, true),
  panel(worktreeSession.id, 'adaptive-logs', 'logs', 1),
  panel(worktreeSession.id, 'adaptive-files', 'explorer', 2, true),
  panel(mainRepoSession.id, 'adaptive-main-logs', 'logs', 0),
  panel(mainRepoSession.id, 'adaptive-main-files', 'explorer', 1, true),
];

async function installFixture(
  page: Page,
  storage: Record<string, string> = {},
  fixturePanels = panels,
): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript((values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  }, storage);
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [worktreeSession, mainRepoSession],
    initialPanels: fixturePanels,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
}

async function openWorktree(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Expand project Adaptive layout fixture$/ }).click();
  await page.getByRole('button', { name: 'Adaptive pane', exact: true }).click();
  await expect(page.locator('.pane-session-content')).toBeVisible();
}

async function setImmersiveMode(page: Page, immersive: boolean): Promise<void> {
  await page.evaluate(async (nextImmersive) => {
    const modulePath = ['/src/stores', 'navigationStore.ts'].join('/');
    // SAFETY: Vite serves this known application module, whose exported store shape is declared here for the browser callback.
    const navigationStore = await import(modulePath) as {
      useNavigationStore: {
        getState: () => { setImmersiveMode: (value: boolean) => void };
      };
    };
    navigationStore.useNavigationStore.getState().setImmersiveMode(nextImmersive);
  }, immersive);
}

test('all worktree surfaces use container bounds, accessible resizing, and durable intent', async ({ page }, testInfo) => {
  await installFixture(page);
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
  await expect(inspectorSeparator).toBeVisible();
  await expect(inspectorSeparator).toHaveAttribute('aria-orientation', 'vertical');
  await expect(inspector).toHaveCSS('width', '360px');

  await inspectorSeparator.focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(inspector).toHaveCSS('width', '410px');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2')))
    .toBe('{"version":2,"preferredPx":410}');
  const widthPreferenceAfterResize = await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'));
  await page.keyboard.press('ArrowUp');
  await expect(inspector).toHaveCSS('width', '410px');
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(widthPreferenceAfterResize);

  const pointerStart = await inspectorSeparator.boundingBox();
  await page.mouse.move(pointerStart!.x + pointerStart!.width / 2, pointerStart!.y + 100);
  await page.mouse.down();
  await page.mouse.move(pointerStart!.x - 30, 2);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => {
    const stored = localStorage.getItem('pane-detail-panel-width:v2');
    return stored ? Number(JSON.parse(stored).preferredPx) : 0;
  })).toBeGreaterThan(410);
  const resizedInspectorWidth = Number.parseInt(await inspector.evaluate(element => getComputedStyle(element).width), 10);
  expect(resizedInspectorWidth).toBeGreaterThan(410);

  const releaseStart = await inspectorSeparator.boundingBox();
  const widthBeforeReleaseTest = Number.parseInt(await inspector.evaluate(element => getComputedStyle(element).width), 10);
  const releaseStartX = releaseStart!.x + releaseStart!.width / 2;
  await page.mouse.move(releaseStartX, releaseStart!.y + 80);
  await page.mouse.down();
  await page.mouse.move(releaseStartX - 10, releaseStart!.y + 80);
  await inspectorSeparator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: releaseStartX - 35,
    clientY: releaseStart!.y + 80,
  });
  await page.mouse.up();
  await expect(inspector).toHaveCSS('width', `${widthBeforeReleaseTest + 35}px`);
  await expect.poll(() => page.evaluate(() => {
    const stored = localStorage.getItem('pane-detail-panel-width:v2');
    return stored ? Number(JSON.parse(stored).preferredPx) : 0;
  })).toBe(widthBeforeReleaseTest + 35);

  const committedInspector = await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'));
  const resizedInspectorWidthAfterRelease = widthBeforeReleaseTest + 35;
  const noOpStart = await inspectorSeparator.boundingBox();
  await page.mouse.click(noOpStart!.x + noOpStart!.width / 2, noOpStart!.y + 120);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(committedInspector);

  await page.mouse.move(noOpStart!.x + noOpStart!.width / 2, noOpStart!.y + 140);
  await page.mouse.down();
  await page.mouse.move(noOpStart!.x - 40, noOpStart!.y + 140);
  await inspectorSeparator.dispatchEvent('pointercancel', { pointerId: 1, clientX: noOpStart!.x - 40, clientY: noOpStart!.y + 140 });
  await page.mouse.up();
  await expect(inspector).toHaveCSS('width', `${resizedInspectorWidthAfterRelease}px`);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(committedInspector);

  const lostCaptureStart = await inspectorSeparator.boundingBox();
  await page.mouse.move(lostCaptureStart!.x + lostCaptureStart!.width / 2, lostCaptureStart!.y + 160);
  await page.mouse.down();
  await page.mouse.move(lostCaptureStart!.x - 25, lostCaptureStart!.y + 160);
  await inspectorSeparator.evaluate(element => {
    if (element.hasPointerCapture(1)) element.releasePointerCapture(1);
  });
  await page.mouse.up();
  await expect(inspector).toHaveCSS('width', `${resizedInspectorWidthAfterRelease}px`);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(committedInspector);

  const center = page.locator('.pane-center-column');
  const centerHeight = (await center.boundingBox())!.height;
  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  const terminalDock = page.locator('.pane-terminal-dock');
  const terminalBox = await terminalDock.boundingBox();
  expect(terminalBox).not.toBeNull();
  expect(terminalBox!.height).toBeCloseTo(Math.round(centerHeight * 0.32), -1);

  const terminalSeparator = page.getByRole('separator', { name: 'Resize terminal' });
  await expect(terminalSeparator).toBeVisible();
  await expect(terminalSeparator).toHaveAttribute('aria-valuemin', '100');
  const separatorBox = await terminalSeparator.boundingBox();
  expect(separatorBox!.height).toBeGreaterThanOrEqual(8);
  expect(separatorBox!.width).toBeGreaterThanOrEqual((await terminalDock.boundingBox())!.width - 1);

  await terminalSeparator.focus();
  await page.keyboard.press('ArrowUp');
  const committedTerminal = await page.evaluate(() => localStorage.getItem('pane-bottom-terminal-height:v2'));
  expect(committedTerminal).toMatch(/^\{"version":2,"preferredPx":\d+\}$/);
  const terminalHeightAfterResize = (await terminalDock.boundingBox())!.height;
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await terminalDock.boundingBox())!.height).toBe(terminalHeightAfterResize);
  expect(await page.evaluate(() => localStorage.getItem('pane-bottom-terminal-height:v2'))).toBe(committedTerminal);
  const heightBeforeReleaseTest = (await terminalDock.boundingBox())!.height;
  const terminalReleaseStart = await terminalSeparator.boundingBox();
  const terminalReleaseStartY = terminalReleaseStart!.y + terminalReleaseStart!.height / 2;
  await page.mouse.move(terminalReleaseStart!.x + 100, terminalReleaseStartY);
  await page.mouse.down();
  await page.mouse.move(terminalReleaseStart!.x + 100, terminalReleaseStartY - 10);
  await terminalSeparator.dispatchEvent('pointerup', {
    pointerId: 1,
    clientX: terminalReleaseStart!.x + 100,
    clientY: terminalReleaseStartY - 35,
  });
  await page.mouse.up();
  await expect.poll(async () => (await terminalDock.boundingBox())!.height).toBe(heightBeforeReleaseTest + 35);
  await expect.poll(() => page.evaluate(() => {
    const stored = localStorage.getItem('pane-bottom-terminal-height:v2');
    return stored ? Number(JSON.parse(stored).preferredPx) : 0;
  })).toBe(heightBeforeReleaseTest + 35);

  const expandedHeight = heightBeforeReleaseTest + 35;
  await page.getByRole('button', { name: 'Collapse terminal', exact: true }).click();
  await expect(terminalSeparator).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  await expect.poll(async () => (await terminalDock.boundingBox())!.height).toBe(expandedHeight);

  const preferredBeforeConstraint = await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'));
  await page.locator('.pane-session-content').evaluate(element => {
    element.setAttribute('style', 'flex: 0 0 400px; width: 400px');
  });
  await expect(inspector).toHaveCSS('width', '0px');
  await expect(inspector.locator('.pane-detail-panel-inner')).toHaveAttribute('inert', '');
  await expect(inspectorSeparator).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preferredBeforeConstraint);
  await page.locator('.pane-session-content').evaluate(element => element.removeAttribute('style'));
  await expect(inspector).toHaveCSS('width', `${resizedInspectorWidthAfterRelease}px`);

  await page.getByRole('button', { name: 'Swap terminal and detail panel positions', exact: true }).click();
  const rightTerminalSeparator = page.getByRole('separator', { name: 'Resize terminal' });
  const bottomDetailSeparator = page.getByRole('separator', { name: 'Resize detail panel' });
  await expect(rightTerminalSeparator).toHaveAttribute('aria-orientation', 'vertical');
  await expect(bottomDetailSeparator).toHaveAttribute('aria-orientation', 'horizontal');
  await bottomDetailSeparator.focus();
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pane-bottom-detail-height:v2')))
    .toMatch(/^\{"version":2,"preferredPx":\d+\}$/);
  const committedBottomDetail = await page.evaluate(() => localStorage.getItem('pane-bottom-detail-height:v2'));
  const horizontalDetail = page.locator('.pane-detail-panel-horizontal');
  await center.evaluate(element => element.setAttribute('style', 'flex: 0 0 220px; height: 220px'));
  await expect(horizontalDetail).toHaveCSS('height', '32px');
  await expect(bottomDetailSeparator).toHaveCount(0);
  const horizontalDetailInner = horizontalDetail.locator('.pane-detail-panel-inner');
  await expect(horizontalDetailInner).toHaveAttribute('inert', '');
  await expect(horizontalDetailInner).toHaveAttribute('aria-hidden', 'true');
  await expect(horizontalDetail.locator('button[aria-label="Collapse detail panel"]')).toBeVisible();
  await expect(horizontalDetail.getByRole('button', { name: 'Collapse detail panel' })).toHaveCount(0);
  await horizontalDetail.locator('button[aria-label="Collapse detail panel"]').focus();
  await expect(horizontalDetail.locator('button[aria-label="Collapse detail panel"]')).not.toBeFocused();
  await expect(horizontalDetail.getByRole('region', { name: 'Commit history' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pane-bottom-detail-height:v2'))).toBe(committedBottomDetail);
  await center.evaluate(element => element.removeAttribute('style'));
  await expect(bottomDetailSeparator).toBeVisible();
  await horizontalDetail.getByRole('button', { name: 'Collapse detail panel' }).click();
  expect(await horizontalDetail.evaluate(element => element.style.height)).toBe('auto');
  expect((await horizontalDetail.boundingBox())!.height).toBeGreaterThanOrEqual(32);
  await expect(horizontalDetailInner).not.toHaveAttribute('inert', '');
  await expect(horizontalDetail.getByRole('button', { name: 'Expand detail panel' })).toBeVisible();

  await center.evaluate(element => {
    element.setAttribute('style', 'flex: 0 0 260px; width: 260px; height: 48px; align-self: flex-start');
  });
  await expect.poll(async () => (await horizontalDetail.boundingBox())!.height).toBeLessThanOrEqual(48);
  expect((await horizontalDetail.boundingBox())!.height).toBeGreaterThan(32);
  await center.evaluate(element => {
    element.setAttribute('style', 'flex: 0 0 260px; width: 260px; height: 20px; align-self: flex-start');
  });
  await expect.poll(async () => (await horizontalDetail.boundingBox())!.height).toBeLessThanOrEqual(20);
  expect(await page.evaluate(() => localStorage.getItem('pane-bottom-detail-height:v2'))).toBe(committedBottomDetail);
  await center.evaluate(element => element.removeAttribute('style'));

  await horizontalDetail.getByRole('button', { name: 'Expand detail panel' }).click();
  await expect(bottomDetailSeparator).toBeVisible();

  const shot = testInfo.outputPath('adaptive-panel-separators.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('adaptive-panel-separators.png', { path: shot, contentType: 'image/png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('render-disabled terminals consume zero geometry and the swapped fixed shell stays clipped', async ({ page }) => {
  await installFixture(page, {
    'pane-terminal-collapsed': 'false',
    'pane-bottom-terminal-height:v2': '{"version":2,"preferredPx":260}',
    'pane-right-terminal-width:v2': '{"version":2,"preferredPx":430}',
  });
  await openWorktree(page);

  const terminalDock = page.locator('.pane-terminal-dock');
  await expect(terminalDock).toHaveCSS('height', '260px');
  await setImmersiveMode(page, true);
  await expect(terminalDock).toHaveCSS('height', '0px');
  await expect(terminalDock.locator('.pane-terminal-shell-body')).toHaveAttribute('inert', '');
  await expect(terminalDock.locator('.pane-terminal-shell-body')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('separator', { name: 'Resize terminal' })).toHaveCount(0);

  await setImmersiveMode(page, false);
  await expect(terminalDock).toHaveCSS('height', '260px');
  await page.getByRole('button', { name: 'Swap terminal and detail panel positions', exact: true }).click();
  const terminalRail = page.locator('.pane-terminal-rail');
  await expect(terminalRail).toHaveCSS('width', '430px');

  await setImmersiveMode(page, true);
  await expect(terminalRail).toHaveCSS('width', '0px');
  await expect(terminalRail.locator('.pane-terminal-rail-shell')).toHaveAttribute('inert', '');
  await expect(terminalRail.locator('.pane-terminal-rail-shell')).toHaveAttribute('aria-hidden', 'true');
  await expect(terminalRail.locator('.pane-terminal-rail-clip')).toHaveCSS('overflow', 'hidden');
  await expect.poll(async () => (await terminalRail.locator('.pane-terminal-rail-clip').boundingBox())!.width).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('zero-height collapsed detail is inert until observed height returns', async ({ page }) => {
  await installFixture(page, {
    'pane-layout-swapped': 'true',
    'pane-detail-collapsed': 'true',
  });
  await openWorktree(page);

  const center = page.locator('.pane-center-column');
  const horizontalDetail = page.locator('.pane-detail-panel-horizontal');
  const horizontalDetailInner = horizontalDetail.locator('.pane-detail-panel-inner');
  const expandButton = horizontalDetail.locator('button[aria-label="Expand detail panel"]');

  await expect(horizontalDetailInner).not.toHaveAttribute('inert', '');
  await expect(horizontalDetail.getByRole('button', { name: 'Expand detail panel' })).toBeVisible();
  await expandButton.focus();
  await expect(expandButton).toBeFocused();

  await center.evaluate(element => {
    element.setAttribute('style', 'flex: 0 0 260px; width: 260px; height: 0; align-self: flex-start');
  });
  await expect(horizontalDetail).toHaveCSS('max-height', '0px');
  await expect.poll(async () => (await horizontalDetailInner.boundingBox())!.height).toBe(0);
  await expect(horizontalDetailInner).toHaveAttribute('inert', '');
  await expect(horizontalDetailInner).toHaveAttribute('aria-hidden', 'true');
  await expect(horizontalDetail.getByRole('button', { name: 'Expand detail panel' })).toHaveCount(0);
  expect(await horizontalDetailInner.locator('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])').evaluateAll(elements => {
    return elements.filter(element => {
      if (!(element instanceof HTMLElement)) return false;
      element.focus();
      return document.activeElement === element;
    }).length;
  })).toBe(0);
  await expect(expandButton).not.toBeFocused();

  await center.evaluate(element => element.removeAttribute('style'));
  await expect.poll(async () => (await horizontalDetail.boundingBox())!.height).toBeGreaterThan(0);
  await expect(horizontalDetailInner).not.toHaveAttribute('inert', '');
  await expect(horizontalDetailInner).toHaveAttribute('aria-hidden', 'false');
  await expect(horizontalDetail.getByRole('button', { name: 'Expand detail panel' })).toBeVisible();
  await expandButton.focus();
  await expect(expandButton).toBeFocused();
});

test('zero-height collapsed terminal chrome is inert until observed height returns', async ({ page }) => {
  await installFixture(page, { 'pane-terminal-collapsed': 'true' });
  await openWorktree(page);

  const center = page.locator('.pane-center-column');
  const dock = page.locator('.pane-terminal-dock');
  const dockContent = dock.locator('.pane-terminal-dock-content');
  const expandButton = dock.locator('button[aria-label="Expand terminal"]');

  await expect(dock).toHaveCSS('height', '32px');
  await expect(dockContent).not.toHaveAttribute('inert', '');
  await expandButton.focus();
  await expect(expandButton).toBeFocused();

  await center.evaluate(element => {
    element.setAttribute('style', 'flex: 0 0 260px; width: 260px; height: 0; align-self: flex-start');
  });
  // border-box keeps the 1px top border, but the content box is zero.
  await expect.poll(async () => (await dockContent.boundingBox())!.height).toBe(0);
  await expect(dockContent).toHaveAttribute('inert', '');
  await expect(dockContent).toHaveAttribute('aria-hidden', 'true');
  await expect(dock.getByRole('button', { name: 'Expand terminal' })).toHaveCount(0);
  await expect(expandButton).not.toBeFocused();

  await center.evaluate(element => element.removeAttribute('style'));
  await expect(dock).toHaveCSS('height', '32px');
  await expect(dockContent).not.toHaveAttribute('inert', '');
  await expect(dockContent).toHaveAttribute('aria-hidden', 'false');
  await expandButton.focus();
  await expect(expandButton).toBeFocused();
});

test('a second pointer cannot restart an active drag from its preview', async ({ page }) => {
  const preference = '{"version":2,"preferredPx":500}';
  await installFixture(page, { 'pane-detail-panel-width:v2': preference });
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  const separator = page.getByRole('separator', { name: 'Resize inspector' });
  await expect(inspector).toHaveCSS('width', '500px');
  const start = await separator.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 100);
  await page.mouse.down();
  await page.mouse.move(start!.x - 40, start!.y + 100);
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(500);
  const preview = (await inspector.boundingBox())!.width;

  await separator.evaluate((element, x) => {
    const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: false };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: x, clientY: 200 }));
    element.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: x - 1, clientY: 200 }));
  }, start!.x - 40);
  await expect(inspector).toHaveCSS('width', `${preview}px`);

  await page.mouse.up();
  await expect(inspector).toHaveCSS('width', `${preview}px`);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(`{"version":2,"preferredPx":${preview}}`);
});

test('non-primary buttons and modifier chords never express resize intent', async ({ page }) => {
  const preference = '{"version":2,"preferredPx":500}';
  await installFixture(page, { 'pane-detail-panel-width:v2': preference });
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  const separator = page.getByRole('separator', { name: 'Resize inspector' });
  await expect(inspector).toHaveCSS('width', '500px');
  const start = await separator.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 100);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(start!.x - 40, start!.y + 100);
  await expect(inspector).toHaveCSS('width', '500px');
  await page.mouse.up({ button: 'right' });
  await expect(inspector).toHaveCSS('width', '500px');
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);

  await separator.focus();
  await page.keyboard.press('Meta+ArrowLeft');
  await page.keyboard.press('Control+ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(inspector).toHaveCSS('width', '500px');
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);
  await page.keyboard.press('ArrowLeft');
  await expect(inspector).toHaveCSS('width', '510px');
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe('{"version":2,"preferredPx":510}');
});

test('a drag while constrained commits the dragged preference and restores it after regrowth', async ({ page }) => {
  await installFixture(page, { 'pane-detail-panel-width:v2': '{"version":2,"preferredPx":700}' });
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  const separator = page.getByRole('separator', { name: 'Resize inspector' });
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThan(700);
  const constrained = (await inspector.boundingBox())!.width;
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe('{"version":2,"preferredPx":700}');

  const start = await separator.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 100);
  await page.mouse.down();
  await page.mouse.move(start!.x + 60, start!.y + 100);
  await page.mouse.up();
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThan(constrained);
  const dragged = (await inspector.boundingBox())!.width;
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(`{"version":2,"preferredPx":${dragged}}`);

  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(inspector).toHaveCSS('width', `${dragged}px`);
  await expect(separator).toBeVisible();
});

test('the swapped right terminal commits only its own v2 key', async ({ page }) => {
  await installFixture(page, {
    'pane-layout-swapped': 'true',
    'pane-right-terminal-width:v2': '{"version":2,"preferredPx":400}',
  });
  await openWorktree(page);

  const separator = page.getByRole('separator', { name: 'Resize terminal' });
  await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
  await expect(separator).toHaveAttribute('aria-valuenow', '400');
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', '410');
  expect(await page.evaluate(() => [
    localStorage.getItem('pane-right-terminal-width:v2'),
    localStorage.getItem('pane-detail-panel-width:v2'),
    localStorage.getItem('pane-project-detail-panel-width:v2'),
    localStorage.getItem('pane-bottom-terminal-height:v2'),
    localStorage.getItem('pane-bottom-detail-height:v2'),
  ])).toEqual(['{"version":2,"preferredPx":410}', null, null, null, null]);
});

test('only one outer-panel drag owns document interaction state at a time', async ({ page }) => {
  await installFixture(page, {
    'pane-terminal-collapsed': 'false',
    'pane-detail-panel-width:v2': '{"version":2,"preferredPx":500}',
    'pane-bottom-terminal-height:v2': '{"version":2,"preferredPx":260}',
  });
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  const terminalDock = page.locator('.pane-terminal-dock');
  const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
  const terminalSeparator = page.getByRole('separator', { name: 'Resize terminal' });
  await expect(inspector).toHaveCSS('width', '500px');
  await expect(terminalDock).toHaveCSS('height', '260px');

  const start = await inspectorSeparator.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 100);
  await page.mouse.down();
  await page.mouse.move(start!.x - 40, start!.y + 100);
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(500);
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('col-resize');

  // A real primary touch pointer on a different separator must not start a
  // second drag while the mouse drag owns document interaction state.
  const terminalBox = await terminalSeparator.boundingBox();
  const touchX = terminalBox!.x + 120;
  const touchY = terminalBox!.y + terminalBox!.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX, y: touchY - 30 }] });
  await page.waitForTimeout(100);
  await expect(terminalDock).toHaveCSS('height', '260px');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('col-resize');

  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }))).toEqual({ cursor: '', userSelect: '' });
  expect(await page.evaluate(() => localStorage.getItem('pane-bottom-terminal-height:v2'))).toBe('{"version":2,"preferredPx":260}');
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).not.toBe('{"version":2,"preferredPx":500}');
});

test('the first committed frame already reflects the container instead of a zero-sized surface', async ({ page }) => {
  await installFixture(page, { 'pane-detail-panel-width:v2': '{"version":2,"preferredPx":500}' });
  // Installed before the session view mounts. Samples the inspector's inline
  // width at every microtask checkpoint after a DOM change and at every
  // animation frame: a zero that survives to either point could be painted,
  // whereas a zero overwritten inside the same synchronous commit cannot.
  await page.evaluate(() => {
    const seen: string[] = [];
    const sample = () => {
      const inspector = document.querySelector<HTMLElement>('.pane-detail-panel-vertical');
      if (!inspector) return;
      seen.push(inspector.style.width);
      document.documentElement.dataset.paneInspectorWidths = seen.join(',');
    };
    new MutationObserver(sample).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
    });
    let frames = 0;
    const frame = () => { sample(); if (++frames < 300) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  await openWorktree(page);
  await expect(page.locator('.pane-detail-panel-vertical')).toHaveCSS('width', '500px');
  const widths = (await page.evaluate(() => document.documentElement.dataset.paneInspectorWidths ?? '')).split(',');
  expect(widths).toContain('500px');
  expect(widths).not.toContain('0px');
});

test('a separator unmounted mid-drag releases drag ownership on pointer release', async ({ page }) => {
  await installFixture(page, {
    'pane-terminal-collapsed': 'false',
    'pane-detail-panel-width:v2': '{"version":2,"preferredPx":500}',
    'pane-bottom-terminal-height:v2': '{"version":2,"preferredPx":260}',
  });
  await openWorktree(page);

  const terminalDock = page.locator('.pane-terminal-dock');
  const terminalSeparator = page.getByRole('separator', { name: 'Resize terminal' });
  await expect(terminalDock).toHaveCSS('height', '260px');
  const start = await terminalSeparator.boundingBox();
  await page.mouse.move(start!.x + 200, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(start!.x + 200, start!.y - 30);
  await expect.poll(async () => (await terminalDock.boundingBox())!.height).toBeGreaterThan(260);
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('row-resize');

  // Keyboard still works under pointer capture: switch to the main-repository
  // pane, which has no terminal, so the dock (and its separator) unmounts
  // while the session view stays mounted.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Tab' : 'Control+Tab');
  await expect(terminalDock).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }))).toEqual({ cursor: '', userSelect: '' });
  expect(await page.evaluate(() => localStorage.getItem('pane-bottom-terminal-height:v2'))).toBe('{"version":2,"preferredPx":260}');

  // Every separator must still accept a drag afterwards (a stuck owner would
  // reject this pointer-down on a different hook instance).
  const inspector = page.locator('.pane-detail-panel-vertical');
  const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
  await expect(inspectorSeparator).toBeVisible();
  const inspectorStart = await inspectorSeparator.boundingBox();
  const inspectorWidth = (await inspector.boundingBox())!.width;
  await page.mouse.move(inspectorStart!.x + inspectorStart!.width / 2, inspectorStart!.y + 100);
  await page.mouse.down();
  await page.mouse.move(inspectorStart!.x - 40, inspectorStart!.y + 100);
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(inspectorWidth);
  await page.mouse.up();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Tab' : 'Control+Shift+Tab');
  await expect(terminalDock).toHaveCSS('height', '260px');
  await expect(terminalSeparator).toBeVisible();
});

test('a separator removed from the DOM mid-drag releases ownership on the next pointer event', async ({ page }) => {
  await installFixture(page, {
    'pane-terminal-collapsed': 'false',
    'pane-detail-panel-width:v2': '{"version":2,"preferredPx":500}',
    'pane-bottom-terminal-height:v2': '{"version":2,"preferredPx":260}',
  });
  await openWorktree(page);

  const terminalDock = page.locator('.pane-terminal-dock');
  const terminalSeparator = page.getByRole('separator', { name: 'Resize terminal' });
  const start = await terminalSeparator.boundingBox();
  await page.mouse.move(start!.x + 200, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(start!.x + 200, start!.y - 30);
  await expect.poll(async () => (await terminalDock.boundingBox())!.height).toBeGreaterThan(260);
  expect(await page.evaluate(() => document.body.style.cursor)).toBe('row-resize');

  // Detach the captured element behind React's back: the hook stays enabled,
  // so no effect can end the transaction and no capture events reach React.
  await terminalSeparator.evaluate(element => element.remove());
  await expect(terminalSeparator).toHaveCount(0);
  // The gesture may end outside the window with no pointerup at all; the next
  // pointer event from this pointer must be enough to release ownership.
  await page.mouse.move(start!.x + 200, start!.y - 31);
  await expect.poll(() => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }))).toEqual({ cursor: '', userSelect: '' });
  await page.mouse.up();
  await expect(terminalDock).toHaveCSS('height', '260px');
  expect(await page.evaluate(() => localStorage.getItem('pane-bottom-terminal-height:v2'))).toBe('{"version":2,"preferredPx":260}');

  // Another hook instance must accept a drag: a stuck shared owner would reject it.
  const inspector = page.locator('.pane-detail-panel-vertical');
  const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
  const inspectorStart = await inspectorSeparator.boundingBox();
  await page.mouse.move(inspectorStart!.x + inspectorStart!.width / 2, inspectorStart!.y + 100);
  await page.mouse.down();
  await page.mouse.move(inspectorStart!.x - 40, inspectorStart!.y + 100);
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(500);
  await page.mouse.up();
});

test('a disappearing separator rolls back tentative intent and restores document interaction state', async ({ page }) => {
  const preference = '{"version":2,"preferredPx":500}';
  await installFixture(page, { 'pane-detail-panel-width:v2': preference });
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  const separator = page.getByRole('separator', { name: 'Resize inspector' });
  await expect(inspector).toHaveCSS('width', '500px');
  await page.evaluate(() => {
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';
  });
  const start = await separator.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 100);
  await page.mouse.down();
  await page.mouse.move(start!.x - 40, start!.y + 100);
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeGreaterThan(500);

  await page.setViewportSize({ width: 600, height: 700 });
  await expect(separator).toHaveCount(0);
  await expect(inspector).toHaveCSS('width', '0px');
  await expect.poll(() => page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }))).toEqual({ cursor: 'crosshair', userSelect: 'text' });
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);
  await page.mouse.up();

  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(inspector).toHaveCSS('width', '500px');
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);

  // A new drag must start from remembered intent, not the abandoned preview:
  // press without moving, force a re-render via a container change, and the
  // inspector must still resolve from the stored 500px preference.
  const previousCap = await separator.getAttribute('aria-valuemax');
  const restart = await separator.boundingBox();
  await page.mouse.move(restart!.x + restart!.width / 2, restart!.y + 100);
  await page.mouse.down();
  await page.setViewportSize({ width: 1380, height: 900 });
  // aria-valuemax is derived from the observed container, so a change proves
  // React re-rendered with the new geometry while the transaction is active.
  await expect(separator).not.toHaveAttribute('aria-valuemax', previousCap!);
  expect((await inspector.boundingBox())!.width).toBe(500);
  await page.mouse.up();
  await expect(inspector).toHaveCSS('width', '500px');
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);
});

test('real sidebar and viewport changes clamp without overwriting and restore without overflow', async ({ page }) => {
  const preference = '{"version":2,"preferredPx":500}';
  await installFixture(page, { 'pane-detail-panel-width:v2': preference });
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  const editor = page.locator('.pane-editor-stage');
  const separator = page.getByRole('separator', { name: 'Resize inspector' });
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThan(500);
  expect((await editor.boundingBox())!.width).toBeGreaterThanOrEqual(319);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(inspector).toHaveCSS('width', '500px');
  await expect(separator).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect.poll(async () => (await inspector.boundingBox())!.width).toBeLessThan(500);
  await page.setViewportSize({ width: 600, height: 700 });
  await expect(inspector).toHaveCSS('width', '0px');
  await expect(inspector.locator('.pane-detail-panel-inner')).toHaveAttribute('inert', '');
  await expect(separator).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(inspector).toHaveCSS('width', '500px');
  await expect(separator).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe(preference);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a terminal arriving after the default branch renders switches the branch and resize enablement together', async ({ page }) => {
  const panelsWithoutWorktreeTerminal = panels.filter(item => item.id !== 'adaptive-dock');
  await installFixture(page, {
    'pane-layout-swapped': 'true',
    'pane-detail-panel-width:v2': '{"version":2,"preferredPx":410}',
    'pane-right-terminal-width:v2': '{"version":2,"preferredPx":430}',
    'pane-bottom-detail-height:v2': '{"version":2,"preferredPx":210}',
  }, panelsWithoutWorktreeTerminal);
  await openWorktree(page);

  const inspector = page.locator('.pane-detail-panel-vertical');
  await expect(page.locator('.pane-terminal-rail')).toHaveCount(0);
  await expect(page.locator('.pane-detail-panel-horizontal')).toHaveCount(0);
  await expect(inspector).toHaveCSS('width', '410px');
  await expect(inspector.locator('.pane-detail-panel-inner')).not.toHaveAttribute('inert', '');
  const inspectorSeparator = page.getByRole('separator', { name: 'Resize inspector' });
  await expect(inspectorSeparator).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Details' })).toBeVisible();

  await page.evaluate((lateTerminal) => {
    // SAFETY: installFixture defines this test-only mock before application code runs.
    const mock = (window as typeof window & {
      __paneTestElectronMock: { emitPanelCreated: (panel: typeof lateTerminal) => void };
    }).__paneTestElectronMock;
    mock.emitPanelCreated(lateTerminal);
  }, panels[0]);

  await expect(inspector).toHaveCount(0);
  await expect(inspectorSeparator).toHaveCount(0);
  const terminalRail = page.locator('.pane-terminal-rail');
  const horizontalDetail = page.locator('.pane-detail-panel-horizontal');
  await expect(terminalRail).toHaveCSS('width', '430px');
  await expect(terminalRail.locator('.pane-terminal-shell-body')).not.toHaveAttribute('inert', '');
  await expect(horizontalDetail).toHaveCSS('height', '210px');
  await expect(horizontalDetail.locator('.pane-detail-panel-inner')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('separator', { name: 'Resize terminal' })).toHaveAttribute('aria-orientation', 'vertical');
  await expect(page.getByRole('separator', { name: 'Resize detail panel' })).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(page.getByRole('separator')).toHaveCount(2);
});

test('an observed active terminal resize debounces through the existing xterm refit path', async ({ page }) => {
  await installFixture(page);
  await openWorktree(page);

  await page.evaluate(() => {
    // SAFETY: This test exclusively owns the optional recorder property for this page.
    const testWindow = window as typeof window & {
      __terminalResizeCalls?: Array<{ panelId: string; cols: number; rows: number }>;
    };
    const originalInvoke = window.electronAPI.invoke.bind(window.electronAPI);
    testWindow.__terminalResizeCalls = [];
    // SAFETY: The wrapper preserves invoke's arguments and return value and only records one channel.
    window.electronAPI.invoke = ((channel: string, ...args: unknown[]) => {
      if (channel === 'terminal:resize') {
        testWindow.__terminalResizeCalls?.push({
          panelId: String(args[0]),
          cols: Number(args[1]),
          rows: Number(args[2]),
        });
      }
      return originalInvoke(channel, ...args);
    }) as typeof window.electronAPI.invoke;
  });

  await page.getByRole('button', { name: 'Expand terminal', exact: true }).click();
  const terminalDock = page.locator('.pane-terminal-dock');
  await expect(terminalDock.locator('.xterm')).toBeVisible();
  await expect(terminalDock.locator('.pane-terminal-shell-body')).not.toHaveAttribute('inert', '');

  // Let mount and activation fitting settle so only the observed container change is recorded.
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    // SAFETY: The recorder was installed by this test earlier in the same page lifetime.
    const testWindow = window as typeof window & { __terminalResizeCalls?: unknown[] };
    testWindow.__terminalResizeCalls = [];
  });

  const initialHeight = (await terminalDock.boundingBox())!.height;
  const terminalSeparator = page.getByRole('separator', { name: 'Resize terminal' });
  await terminalSeparator.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await terminalDock.boundingBox())!.height).toBe(initialHeight + 20);

  await expect.poll(() => page.evaluate(() => {
    // SAFETY: The recorder was installed by this test earlier in the same page lifetime.
    const testWindow = window as typeof window & {
      __terminalResizeCalls?: Array<{ panelId: string; cols: number; rows: number }>;
    };
    return testWindow.__terminalResizeCalls?.length ?? 0;
  })).toBe(1);
  await page.waitForTimeout(200);
  const resizeCalls = await page.evaluate(() => {
    // SAFETY: The recorder was installed by this test earlier in the same page lifetime.
    const testWindow = window as typeof window & {
      __terminalResizeCalls?: Array<{ panelId: string; cols: number; rows: number }>;
    };
    return testWindow.__terminalResizeCalls ?? [];
  });
  expect(resizeCalls).toHaveLength(1);
  expect(resizeCalls[0]).toMatchObject({ panelId: 'adaptive-dock' });
  expect(resizeCalls[0].cols).toBeGreaterThanOrEqual(2);
  expect(resizeCalls[0].rows).toBeGreaterThanOrEqual(1);
});

test('worktree and main-repository inspectors restore separate v2 preferences', async ({ page }) => {
  await installFixture(page, {
    'pane-detail-panel-width:v2': '{"version":2,"preferredPx":440}',
    'pane-project-detail-panel-width:v2': '{"version":2,"preferredPx":520}',
  });
  await openWorktree(page);
  await expect(page.locator('.pane-detail-panel-vertical')).toHaveCSS('width', '440px');

  await page.getByRole('button', { name: `Project actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  const projectInspector = page.locator('.pane-detail-panel-vertical');
  await expect(projectInspector).toHaveCSS('width', '520px');
  const projectSeparator = page.getByRole('separator', { name: 'Resize main repository inspector' });
  await expect(projectSeparator).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe('{"version":2,"preferredPx":440}');

  const start = await projectSeparator.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + 100);
  await page.mouse.down();
  await page.mouse.move(start!.x + 40, start!.y + 100);
  await page.mouse.up();
  await expect.poll(async () => (await projectInspector.boundingBox())!.width).toBeLessThan(520);
  const draggedProject = (await projectInspector.boundingBox())!.width;
  expect(await page.evaluate(() => localStorage.getItem('pane-project-detail-panel-width:v2'))).toBe(`{"version":2,"preferredPx":${draggedProject}}`);
  expect(await page.evaluate(() => localStorage.getItem('pane-detail-panel-width:v2'))).toBe('{"version":2,"preferredPx":440}');
  await page.evaluate(() => localStorage.setItem('pane-project-detail-panel-width:v2', '{"version":2,"preferredPx":520}'));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: `Project actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  await expect(page.locator('.pane-detail-panel-vertical')).toHaveCSS('width', '520px');
});
