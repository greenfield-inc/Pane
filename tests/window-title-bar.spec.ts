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

const baseSession = {
  prompt: 'Verify the title bar',
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

const worktreeSession = {
  ...baseSession,
  id: 'title-bar-worktree',
  name: 'scrub Sentry request bodies (TM-622)',
  worktreePath: '/tmp/bloom-mono/worktrees/scrub-sentry',
  displayOrder: 0,
};

const mainRepoSession = {
  ...baseSession,
  id: 'title-bar-main-repo',
  name: 'bloom-mono',
  worktreePath: '/tmp/bloom-mono',
  isMainRepo: true,
  displayOrder: 1,
};

const titleBarLabel = (page: Page) => page.getByTestId('window-title-bar-label');

async function openDesktop(
  page: Page,
  platform: 'darwin' | 'win32' = 'darwin',
  windowControlsOverlay = false,
): Promise<void> {
  // macOS is detected from navigator.platform (isMac), so pin it here instead of
  // skipping the test everywhere else. Windows and Linux instead ask the preload
  // whether main gave the page the title bar, which is the flag below.
  await page.addInitScript((navigatorPlatform) => {
    Object.defineProperty(window.navigator, 'platform', { get: () => navigatorPlatform });
  }, platform === 'darwin' ? 'MacIntel' : 'Win32');
  await installElectronApiMock(page, {
    platform,
    windowControlsOverlayEnabled: windowControlsOverlay,
    initialProjects: [project],
    initialSessions: [worktreeSession, mainRepoSession],
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 15_000 });
}

test.describe('window title bar', () => {
  test('names the active pane and follows a rename', async ({ page }) => {
    await openDesktop(page);

    // Nothing is open yet, so the bar stays the empty drag strip it has always been.
    await expect(page.getByTestId('window-title-bar')).toBeVisible();
    await expect(titleBarLabel(page)).toHaveCount(0);

    await page.getByRole('button', { name: worktreeSession.name, exact: true }).click();
    await expect(titleBarLabel(page)).toHaveText(
      `${project.name}·${worktreeSession.name}`,
    );

    // A rename arrives as a session:updated event; the bar must follow it live.
    await page.evaluate((renamed) => (
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      window as typeof window & {
        __paneTestElectronMock: { emitSessionUpdated: (session: typeof worktreeSession) => void };
      }
    ).__paneTestElectronMock.emitSessionUpdated(renamed),
    { ...worktreeSession, name: 'redact request bodies (TM-622)' });

    await expect(titleBarLabel(page)).toHaveText(
      `${project.name}·redact request bodies (TM-622)`,
    );
  });

  test('shows only the project for the main-repo pane', async ({ page }) => {
    await openDesktop(page);

    await page.getByRole('button', { name: mainRepoSession.name, exact: true }).click();
    await expect(titleBarLabel(page)).toHaveText(project.name);
  });

  test('clears the macOS traffic lights before app controls', async ({ page }) => {
    await openDesktop(page);

    const controls = page.getByTestId('window-title-bar-controls');
    await expect(controls).toHaveCSS('left', '88px');

    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    const collapseBox = await collapse.boundingBox();
    expect(collapseBox?.x).toBeGreaterThanOrEqual(88);
  });

  test('badges the PR and merge readiness without moving the title', async ({ page }) => {
    await openDesktop(page);
    await page.getByRole('button', { name: worktreeSession.name, exact: true }).click();

    await expect(titleBarLabel(page)).toBeVisible();
    await expect(page.getByTestId('window-title-bar-pills')).toHaveCount(0);
    const centeredBefore = await titleBarLabel(page).evaluate((label) => {
      const box = label.getBoundingClientRect();
      return Math.round(box.left + box.width / 2);
    });

    await page.evaluate((update) => (
      // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
      window as typeof window & {
        __paneTestElectronMock: {
          emitGitStatusUpdated: (sessionId: string, gitStatus: typeof update.gitStatus) => void;
        };
      }
    ).__paneTestElectronMock.emitGitStatusUpdated(update.id, update.gitStatus),
    {
      id: worktreeSession.id,
      gitStatus: {
        state: 'ahead',
        ahead: 3,
        isReadyToMerge: true,
        prNumber: 472,
        prState: 'OPEN',
        prTitle: 'Show project and pane name in the title bar',
      },
    });

    const pills = page.getByTestId('window-title-bar-pills');
    await expect(pills).toHaveText('#472Ready to merge');
    await expect(pills.getByTitle(/Pull request #472 \(open\)/)).toBeVisible();

    // The pills hang off the end of the title, so the name itself must not shift.
    const centeredAfter = await titleBarLabel(page).evaluate((label) => {
      const box = label.getBoundingClientRect();
      return Math.round(box.left + box.width / 2);
    });
    expect(centeredAfter).toBe(centeredBefore);
  });

  test('names the window itself, on platforms with no strip too', async ({ page }) => {
    // A Linux desktop that fails the Window Controls Overlay gate keeps its
    // native title bar, so document.title is the only place the pane name can
    // reach it — plus every platform's taskbar and task switcher.
    await openDesktop(page, 'win32');

    await expect(page.getByTestId('window-title-bar')).toHaveCount(0);
    await expect.poll(() => page.title()).toBe('Pane');

    await page.getByRole('button', { name: worktreeSession.name, exact: true }).click();
    await expect.poll(() => page.title())
      .toBe(`${project.name} · ${worktreeSession.name}`);

    await page.getByRole('button', { name: mainRepoSession.name, exact: true }).click();
    await expect.poll(() => page.title()).toBe(project.name);

    // Leaving the pane for Pane Chat releases the name again.
    await page.getByRole('button', { name: 'Pane Chat' }).first().click();
    await expect.poll(() => page.title()).toBe('Pane');
  });

  test('takes over the strip when the window controls overlay is on', async ({ page }) => {
    await openDesktop(page, 'win32', true);

    await expect(page.getByTestId('window-title-bar')).toBeVisible();
    await page.getByRole('button', { name: worktreeSession.name, exact: true }).click();
    await expect(titleBarLabel(page)).toHaveText(
      `${project.name}·${worktreeSession.name}`,
    );

    const insets = await page.evaluate(() => {
      const read = (testId: string) => {
        const slot = document.querySelector(`[data-testid="${testId}"]`);
        if (!(slot instanceof HTMLElement)) return null;
        const computed = getComputedStyle(slot);
        return {
          specifiedLeft: slot.style.left,
          specifiedRight: slot.style.right,
          computedLeft: computed.left,
          computedRight: computed.right,
        };
      };
      return {
        leading: read('window-title-bar-controls'),
        trailing: read('window-title-bar-trailing-controls'),
      };
    });

    // The insets are driven by the overlay's own geometry, so the controls are
    // cleared wherever the OS puts them — on the right, or on the left under an
    // RTL system layout — at whatever width the current DPI makes them.
    expect(insets.leading?.specifiedLeft).toContain('titlebar-area-x');
    expect(insets.trailing?.specifiedRight).toContain('titlebar-area-width');
    // Never the macOS traffic-light inset, which is the wrong side here.
    expect(insets.leading?.computedLeft).not.toBe('88px');
    // A browser reports no titlebar-area, which is the shape a window that lost
    // the overlay would compute: the fallbacks have to leave a usable symmetric
    // gutter rather than collapse it.
    expect(insets.leading?.computedLeft).toBe('8px');
    expect(insets.trailing?.computedRight).toBe('8px');

    // The pane name shares the row with the tabs and stays clear of the
    // trailing controls, so nothing on the title plane covers it.
    const labelBox = await titleBarLabel(page).boundingBox();
    const trailingBox = await page.getByTestId('window-title-bar-trailing-controls').boundingBox();
    if (!labelBox || !trailingBox) throw new Error('Title bar label or trailing controls have no box');
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(trailingBox.x);
    expect(labelBox.y).toBeLessThan(38);
  });

  test('keeps the whole strip draggable', async ({ page }) => {
    await openDesktop(page);
    await page.getByRole('button', { name: worktreeSession.name, exact: true }).click();

    const dragRegions = await titleBarLabel(page).evaluate((label) => {
      const regionOf = (element: Element | null) => (
        element ? getComputedStyle(element).getPropertyValue('-webkit-app-region') : null
      );
      // The title strip is the pane tab row: its free space, which holds the
      // name, is the window's drag surface.
      return {
        row: regionOf(label.closest('.panel-tab-bar-with-title-controls > div')),
        slot: regionOf(label.closest('[data-testid="panel-tab-bar-title-slot"]')),
        label: regionOf(label),
      };
    });

    expect(dragRegions.row).toBe('drag');
    // The name and its slot inherit the row's region instead of carving a
    // no-drag hole in it.
    expect(dragRegions.slot).not.toBe('no-drag');
    expect(dragRegions.label).not.toBe('no-drag');
  });
});
