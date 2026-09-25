import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const project = {
  id: 1,
  name: 'bloomapi/bloom-mono',
  path: '/tmp/bloom-mono',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};
const session = {
  id: 'title-bar-worktree',
  name: 'scrub Sentry request bodies (TM-622)',
  prompt: 'Verify the tab bar',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  worktreePath: '/tmp/bloom-mono/worktrees/scrub-sentry',
  isFavorite: false,
  toolType: 'none',
  archived: false,
  displayOrder: 0,
};

async function openDesktop(page: Page, platform: 'darwin' | 'win32' = 'darwin', windowControlsOverlay = false): Promise<void> {
  await page.addInitScript((navigatorPlatform) => {
    Object.defineProperty(window.navigator, 'platform', { get: () => navigatorPlatform });
  }, platform === 'darwin' ? 'MacIntel' : 'Win32');
  await installElectronApiMock(page, {
    platform,
    windowControlsOverlayEnabled: windowControlsOverlay,
    initialProjects: [project],
    initialSessions: [session],
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByTestId('sidebar').first()).toBeVisible({ timeout: 15_000 });
}

test.describe('window chrome', () => {
  test('keeps the empty Home title strip draggable', async ({ page }) => {
    await openDesktop(page);
    const dragRegion = page.getByTestId('home-drag-region');
    const sidebar = page.getByTestId('sidebar').first();
    const [dragBox, sidebarBox] = await Promise.all([dragRegion.boundingBox(), sidebar.boundingBox()]);
    expect(dragBox?.y).toBe(0);
    expect(dragBox?.height).toBe(38);
    expect(dragBox && sidebarBox && dragBox.x).toBe(sidebarBox!.x + sidebarBox!.width);
    await expect(dragRegion).toHaveCSS('-webkit-app-region', 'drag');
  });

  test('puts worktree tabs at the window edge with sidebar color behind window controls', async ({ page }, testInfo) => {
    await openDesktop(page);
    await page.getByRole('button', { name: session.name, exact: true }).click();
    const sidebar = page.getByTestId('sidebar').first();
    const tabBar = page.locator('.panel-tab-bar');
    await expect(tabBar).toBeVisible();
    await expect(page.getByTestId('window-title-bar-label')).toHaveCount(0);

    const positions = await page.evaluate(() => {
      const sidebarElement = document.querySelector('[data-testid="sidebar"]');
      const tabElement = document.querySelector('.panel-tab-bar');
      const contentElement = document.querySelector('.pane-session-content');
      if (!(sidebarElement instanceof HTMLElement) || !(tabElement instanceof HTMLElement) || !(contentElement instanceof HTMLElement)) return null;
      return {
        sidebarTop: sidebarElement.getBoundingClientRect().top,
        tabTop: tabElement.getBoundingClientRect().top,
        contentTop: contentElement.getBoundingClientRect().top,
        tabBottom: tabElement.getBoundingClientRect().bottom,
        sidebarColor: getComputedStyle(sidebarElement).backgroundColor,
        tabRegion: getComputedStyle(tabElement).getPropertyValue('-webkit-app-region'),
        tabDragRegion: getComputedStyle(tabElement.firstElementChild!).getPropertyValue('-webkit-app-region'),
      };
    });
    expect(positions?.sidebarTop).toBe(0);
    expect(positions?.tabTop).toBe(0);
    expect(positions?.contentTop).toBe(positions?.tabBottom);
    expect(positions?.sidebarColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(positions?.tabRegion).toBe('no-drag');
    expect(positions?.tabDragRegion).toBe('drag');
    const detailsToggle = await page.getByRole('button', { name: /^(Show|Hide) details$/ }).boundingBox();
    const tabDragBox = await tabBar.locator(':scope > div').boundingBox();
    expect(detailsToggle && tabDragBox && tabDragBox.x + tabDragBox.width).toBeLessThanOrEqual(detailsToggle!.x);
    await expect(sidebar.getByRole('button', { name: 'New project' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Settings' })).toBeVisible();
    const screenshot = testInfo.outputPath('top-tabs.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('top-tabs.png', { path: screenshot, contentType: 'image/png' });
  });

  test('shows PR and merge pills in the title strip only while the sidebar is collapsed', async ({ page }) => {
    await openDesktop(page);
    await page.getByRole('button', { name: session.name, exact: true }).click();
    await page.evaluate((update) => (
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      window as typeof window & {
        __paneTestElectronMock: { emitGitStatusUpdated: (sessionId: string, gitStatus: typeof update.gitStatus) => void };
      }
    ).__paneTestElectronMock.emitGitStatusUpdated(update.id, update.gitStatus), {
      id: session.id,
      gitStatus: { state: 'ahead', ahead: 3, isReadyToMerge: true, prNumber: 472, prState: 'OPEN', prTitle: 'Scrub request bodies' },
    });

    const pills = page.getByTestId('window-title-bar-pills');
    await expect(pills).toHaveCount(0);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(pills).toHaveText('#472Ready to merge');
    await expect(pills.getByTitle('Pull request #472 (open) — Scrub request bodies')).toBeVisible();
    const [pillsBox, tabBarBox] = await Promise.all([pills.boundingBox(), page.locator('.panel-tab-bar').boundingBox()]);
    expect(pillsBox && tabBarBox && pillsBox.y).toBeLessThan(tabBarBox!.y + tabBarBox!.height);

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(pills).toHaveCount(0);
  });

  test('keeps pane tabs clear of the window controls while the sidebar is collapsed', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, 'platform', { get: () => 'MacIntel' });
    });
    await installElectronApiMock(page, {
      platform: 'darwin',
      initialProjects: [project],
      initialSessions: [session],
      // The first terminal docks at the bottom; the second one is a tab.
      initialPanels: ['Terminal', 'Codex'].map((title, position) => ({
        id: `title-bar-${position}`, sessionId: session.id, type: 'terminal', title,
        state: { isActive: position === 1, hasBeenViewed: true, customState: { isInitialized: false } },
        metadata: { createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(), position },
      })),
      initialUiState: { expandedProjects: [project.id] },
      activeProjectId: project.id,
    });
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: session.name, exact: true }).click();
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();

    const toggle = await page.getByRole('button', { name: 'Expand sidebar' }).boundingBox();
    const tab = await page.getByRole('tab', { name: 'Codex' }).boundingBox();
    expect(toggle && tab && tab.x).toBeGreaterThanOrEqual(toggle!.x + toggle!.width);
  });

  test('keeps window controls clickable and clears the macOS traffic lights', async ({ page }) => {
    await openDesktop(page);
    const controls = page.getByTestId('window-title-bar-controls');
    await expect(controls).toHaveCSS('left', '88px');
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    const collapseBox = await collapse.boundingBox();
    expect(collapseBox?.x).toBeGreaterThanOrEqual(88);
    const sidebarDragBox = await page.locator('[data-testid="sidebar"] .pane-drag-area').boundingBox();
    expect(sidebarDragBox && collapseBox && sidebarDragBox.x).toBeGreaterThanOrEqual(collapseBox!.x + collapseBox!.width);
    await collapse.click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await expect(page.locator('[data-testid="sidebar"] .pane-drag-area')).toHaveCount(0);
  });

  test('keeps Home in the footer menu and shows pane status as a dot', async ({ page }, testInfo) => {
    await openDesktop(page);
    const sidebar = page.getByTestId('sidebar').first();
    const newRepository = sidebar.getByRole('button', { name: 'New project' });
    const homeMenu = sidebar.getByRole('button', { name: 'Home menu' });
    await expect(homeMenu).toBeVisible();
    const [sidebarBox, homeBox] = await Promise.all([sidebar.boundingBox(), homeMenu.boundingBox()]);
    expect(sidebarBox && homeBox && homeBox.width).toBeGreaterThan(sidebarBox!.width / 2);
    await homeMenu.click();
    await expect(page.getByRole('menuitem', { name: 'Home', exact: true })).toBeVisible();
    const remoteItem = page.getByRole('menuitem', { name: 'Remote', exact: true });
    const aboutItem = page.getByRole('menuitem', { name: /About Pane/ });
    await expect(remoteItem).toHaveCSS('height', '28px');
    await expect(aboutItem).toHaveCSS('height', '28px');
    await remoteItem.hover();
    await expect(page.getByRole('tooltip')).toContainText('Remote inactive');
    await aboutItem.hover();
    await expect(page.getByRole('tooltip')).toContainText('vtest');
    await page.screenshot({ path: testInfo.outputPath('home-menu.png') });
    await page.getByRole('menuitem', { name: 'Home', exact: true }).click();
    await expect(newRepository).toBeVisible();

    await page.evaluate((sessionId) => {
      // SAFETY: installElectronApiMock defines this test-only bridge before page load.
      (window as Window & {
        __paneTestElectronMock: { emitPanelAgentStatus: (panelId: string, sessionId: string, state: string) => void };
      }).__paneTestElectronMock.emitPanelAgentStatus('pane-status', sessionId, 'idle');
    }, session.id);
    const row = sidebar.getByRole('button', { name: session.name, exact: true }).locator('..');
    const status = row.getByRole('status', { name: 'Agent idle' });
    await expect(status).toBeVisible();
    await expect(status.locator('span')).toHaveClass(/rounded-full/);
    const projectRow = sidebar.getByRole('button', { name: `Collapse project ${project.name}` }).locator('..');
    await expect(projectRow.getByRole('status')).toHaveCount(0);
  });

  test('spaces project actions evenly', async ({ page }) => {
    await openDesktop(page);
    const actions = page.getByRole('button', { name: `Project actions for ${project.name}` });
    await actions.locator('..').hover();
    await actions.click();
    const rows = await Promise.all([
      'Open session on main', 'Project settings', 'Delete project',
    ].map(name => page.getByRole('menuitem', { name, exact: true }).boundingBox()));
    expect(rows.every(Boolean)).toBe(true);
    expect(rows[1]!.y - (rows[0]!.y + rows[0]!.height)).toBe(0);
    expect(rows[2]!.y - (rows[1]!.y + rows[1]!.height)).toBe(0);
  });

  test('does not select sidebar labels when dragged across', async ({ page }) => {
    await openDesktop(page);
    const sidebar = page.getByTestId('sidebar').first();
    const start = await sidebar.getByText('Home', { exact: true }).boundingBox();
    const end = await sidebar.getByText('Projects', { exact: true }).boundingBox();
    if (!start || !end) throw new Error('Sidebar navigation is missing');
    const dragAcrossLabels = async () => {
      await page.mouse.move(start.x + 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(end.x + end.width - 2, end.y + end.height / 2, { steps: 8 });
      await page.mouse.up();
      return page.evaluate(() => window.getSelection()?.toString() ?? '');
    };
    const selectable = await page.addStyleTag({ content: '.pane-sidebar-shell, .pane-sidebar-shell * { user-select: text !important; }' });
    expect(await dragAcrossLabels()).not.toBe('');
    await selectable.evaluate(element => element.remove());
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    expect(await dragAcrossLabels()).toBe('');
  });

  test('keeps document title on native-framed platforms', async ({ page }) => {
    await openDesktop(page, 'win32');
    await expect(page.getByTestId('window-title-bar')).toHaveCount(0);
    await page.getByRole('button', { name: session.name, exact: true }).click();
    await expect.poll(() => page.title()).toBe(`${project.name} · ${session.name}`);
  });

  test('uses the window controls overlay without adding a title row', async ({ page }) => {
    await openDesktop(page, 'win32', true);
    await page.getByRole('button', { name: session.name, exact: true }).click();
    await expect(page.locator('.panel-tab-bar')).toBeVisible();
    const tabTop = await page.locator('.panel-tab-bar').evaluate(element => element.getBoundingClientRect().top);
    expect(tabTop).toBe(0);
    const controls = page.getByTestId('window-title-bar-controls');
    await expect(controls).toHaveCSS('left', '8px');
  });
});
